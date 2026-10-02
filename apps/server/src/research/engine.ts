import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { hasToolCall, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import type {
  OpenAiCompatibleProvider,
  RequestLlmConfig,
  ResearchDefaults,
  ResearchFinalResult,
  ResearchRequest,
  SearchResult,
} from "@agentic-web-research/core";
import type { AppConfig } from "../config";
import type { Database } from "../db/database";
import { hasProviderCredentials } from "../db/database";
import type { SseEmitter } from "../utils/sse";
import { Semaphore } from "../utils/semaphore";
import { searchWeb } from "./search";
import type { ResearchRuntime } from "./runtime";

export type ResearchRunInput = {
  taskId: string;
  request: ResearchRequest;
  defaults: ResearchDefaults;
  config: AppConfig;
  db: Database;
  emit: SseEmitter;
  runtime: ResearchRuntime;
  llmOverride?: RequestLlmConfig;
  signal?: AbortSignal;
};

type RunStats = {
  searchedAt?: string;
  pagesRendered: number;
  toolCalls: number;
  startedAt: string;
  finishedAt?: string;
};

function mergeOptions(request: ResearchRequest, defaults: ResearchDefaults) {
  return {
    maxConcurrency: request.maxConcurrency ?? defaults.maxConcurrency,
    maxDepth: request.maxDepth ?? defaults.maxDepth,
    maxPages: request.maxPages ?? defaults.maxPages,
    timeoutMs: request.timeoutMs ?? defaults.timeoutMs,
    pageTimeoutMs: defaults.pageTimeoutMs,
    allowPrivateNetworks: defaults.allowPrivateNetworks,
  };
}

function formatSearchResults(results: SearchResult[]) {
  return results
    .map((result, index) => {
      return [
        `${index + 1}. ${result.title}`,
        `URL: ${result.url}`,
        result.snippet ? `Snippet: ${result.snippet}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function trimMarkdown(markdown: string) {
  const maxChars = 45000;
  return markdown.length > maxChars
    ? `${markdown.slice(0, maxChars)}\n\n[Content truncated]`
    : markdown;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Research request aborted");
  }
}

export async function readStreamPart<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  throwIfAborted(signal);
  return await new Promise<IteratorResult<T>>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Research request aborted"),
      );
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    iterator.next().then(
      (part) => {
        cleanup();
        resolve(part);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function normalizeSourceUrl(input: string) {
  const url = new URL(input);
  url.hash = "";
  return url.toString();
}

function mergeSearchResults(
  searchResults: SearchResult[],
  sourceUrls: string[],
) {
  const seen = new Set<string>();
  return [
    ...sourceUrls.map((url) => ({
      title: url,
      url,
      engine: "provided",
    })),
    ...searchResults,
  ].filter((result) => {
    let normalized: string;
    try {
      normalized = normalizeSourceUrl(result.url);
    } catch {
      return false;
    }
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    result.url = normalized;
    return true;
  });
}

export function filterRenderedSources(
  sources: ResearchFinalResult["sources"],
  renderedSources: ReadonlyMap<string, { title?: string; used: boolean }>,
) {
  return sources
    .map((source) => ({ ...source, url: normalizeSourceUrl(source.url) }))
    .filter((source) => renderedSources.has(source.url));
}

export async function resolveLlmProvider(
  db: Database,
  llmOverride?: RequestLlmConfig,
): Promise<{
  provider: RequestLlmConfig | OpenAiCompatibleProvider;
  source: "request" | "database";
}> {
  if (llmOverride) return { provider: llmOverride, source: "request" };

  const activeProvider = await db.getActiveLlmProvider();
  if (!activeProvider) {
    throw new Error("No active LLM provider is configured");
  }
  if (!hasProviderCredentials(activeProvider)) {
    throw new Error(
      "Active LLM provider is missing an API key or auth headers",
    );
  }
  return { provider: activeProvider, source: "database" };
}

export async function runResearch(input: ResearchRunInput) {
  const { taskId, request, defaults, config, db, emit, runtime, llmOverride } =
    input;
  const options = mergeOptions(request, defaults);
  const deadlineSignal = AbortSignal.timeout(options.timeoutMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, deadlineSignal])
    : deadlineSignal;
  const stats: RunStats = {
    pagesRendered: 0,
    toolCalls: 0,
    startedAt: new Date().toISOString(),
  };
  const deadline = Date.now() + options.timeoutMs;

  throwIfAborted(signal);
  await emit("search_started", { query: request.query });
  const searchResults = mergeSearchResults(
    await searchWeb(config.SEARXNG_URL, request.query, { signal }),
    request.sourceUrls ?? [],
  );
  stats.searchedAt = new Date().toISOString();

  for (const result of searchResults) {
    await emit("search_result", result);
  }

  const resolvedProvider = await resolveLlmProvider(db, llmOverride);
  const llmProvider = resolvedProvider.provider;

  if (resolvedProvider.source === "database") {
    const activeProvider = llmProvider as OpenAiCompatibleProvider;
    await db.log("info", "Using active LLM provider", {
      providerId: activeProvider.id,
      providerName: activeProvider.name,
      endpoint: activeProvider.endpoint,
      model: activeProvider.model,
      headerNames: Object.keys(activeProvider.headers),
    });
  } else {
    await db.log("info", "Using request-scoped LLM provider");
  }

  const renderer = runtime.renderer;
  const semaphore = new Semaphore(options.maxConcurrency);
  const depths = new Map<string, number>();
  const renderedSources = new Map<string, { title?: string; used: boolean }>();
  let submitted: ResearchFinalResult | null = null;
  let accumulatedAnswer = "";

  for (const result of searchResults) {
    depths.set(result.url, 1);
  }

  const runAgent = async () => {
    const provider = createOpenAICompatible({
      name:
        resolvedProvider.source === "database"
          ? (llmProvider as OpenAiCompatibleProvider).name || "admin-configured"
          : "request-scoped",
      apiKey: llmProvider.apiKey,
      baseURL: llmProvider.endpoint,
      headers: llmProvider.headers,
    });

    const result = streamText({
      model: provider(llmProvider.model),
      ...(llmProvider.temperature === undefined
        ? {}
        : { temperature: llmProvider.temperature }),
      maxOutputTokens: llmProvider.maxOutputTokens,
      abortSignal: signal,
      stopWhen: [
        hasToolCall("submit_research_result"),
        stepCountIs(Math.min(options.maxPages + options.maxDepth + 4, 16)),
      ],
      system:
        "You are a focused web research agent. Use the provided search results and page-viewing tool to gather enough evidence. " +
        "Prefer authoritative primary sources. Do not invent sources. When you have enough information, call submit_research_result with a concise answer and source list.",
      prompt: [
        `Research query: ${request.query}`,
        "",
        `Limits: max ${options.maxPages} rendered pages, max navigation depth ${options.maxDepth}, max ${options.maxConcurrency} concurrent page renders.`,
        "",
        "Initial search results:",
        searchResults.length
          ? formatSearchResults(searchResults)
          : "No search results were returned.",
      ].join("\n"),
      tools: {
        view_page: tool({
          description:
            "Render a web page, convert the readable page content to Markdown, and return useful links for further navigation.",
          inputSchema: z.object({
            url: z.string().url(),
            reason: z.string().min(1).max(500),
            sourceUrl: z.string().url().optional(),
          }),
          execute: async ({ url, reason, sourceUrl }) => {
            throwIfAborted(signal);
            if (Date.now() > deadline) {
              return { error: "Research task timed out" };
            }
            if (stats.pagesRendered >= options.maxPages) {
              return { error: `Page limit reached (${options.maxPages})` };
            }

            const sourceDepth = sourceUrl ? (depths.get(sourceUrl) ?? 1) : 0;
            const depth = sourceUrl ? sourceDepth + 1 : (depths.get(url) ?? 1);
            if (depth > options.maxDepth) {
              return {
                error: `Navigation depth ${depth} exceeds maxDepth ${options.maxDepth}`,
              };
            }

            stats.toolCalls += 1;
            stats.pagesRendered += 1;
            await emit("page_fetch_started", { url, reason, depth });

            try {
              const rendered = await semaphore.run(
                () =>
                  runtime.pageRenders.run(
                    () =>
                      renderer.render(url, {
                        timeoutMs: options.pageTimeoutMs,
                        allowPrivateNetworks: options.allowPrivateNetworks,
                        signal,
                      }),
                    signal,
                  ),
                signal,
              );
              depths.set(rendered.finalUrl, depth);
              depths.set(url, depth);
              renderedSources.set(normalizeSourceUrl(rendered.finalUrl), {
                title: rendered.title,
                used: true,
              });

              await emit("page_fetch_finished", {
                url: rendered.finalUrl,
                title: rendered.title,
                markdownLength: rendered.markdown.length,
                links: rendered.links.length,
              });

              return {
                url: rendered.finalUrl,
                title: rendered.title,
                depth,
                markdown: trimMarkdown(rendered.markdown),
                links: rendered.links.slice(0, 30),
              };
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Unknown render error";
              await emit("error", { url, message });
              return { error: message };
            }
          },
        }),
        submit_research_result: tool({
          description: "Submit the final research answer and stop researching.",
          inputSchema: z.object({
            answer: z.string().min(1),
            sources: z.array(
              z.object({
                url: z.string().url(),
                title: z.string().optional(),
                used: z.boolean().default(true),
              }),
            ),
            confidence: z.enum(["low", "medium", "high"]).optional(),
            notes: z.string().optional(),
          }),
          execute: async (finalResult) => {
            const sources = filterRenderedSources(
              finalResult.sources,
              renderedSources,
            );
            submitted = { ...finalResult, sources };
            await emit("source", { sources });
            return { accepted: true };
          },
        }),
      },
    });

    const streamIterator = (
      result.fullStream as AsyncIterable<Record<string, unknown>>
    )[Symbol.asyncIterator]();
    while (true) {
      const next = await readStreamPart(streamIterator, signal);
      if (next.done) break;
      const part = next.value;
      if (part.type === "text-delta") {
        const text =
          typeof part.text === "string"
            ? part.text
            : typeof part.delta === "string"
              ? part.delta
              : "";
        if (text) {
          accumulatedAnswer += text;
          await emit("answer_delta", { text });
        }
      }

      if (part.type === "tool-call") {
        await emit("agent_thought", {
          tool: part.toolName,
          args: part.input ?? part.args ?? {},
        });
      }

      if (part.type === "error") {
        const error =
          part.error instanceof Error
            ? part.error.message
            : String(part.error ?? "Unknown AI SDK error");
        throw new Error(error);
      }
    }

    const fallbackSources = Array.from(renderedSources.entries()).map(
      ([url, source]) => ({
        url,
        title: source.title,
        used: source.used,
      }),
    );
    const finalResult: ResearchFinalResult =
      submitted ??
      ({
        answer:
          accumulatedAnswer.trim() ||
          "The agent did not produce a final answer.",
        sources: fallbackSources,
        confidence: "low",
        notes: "The model ended without calling submit_research_result.",
      } satisfies ResearchFinalResult);

    stats.finishedAt = new Date().toISOString();
    await emit("final", finalResult as unknown as Record<string, unknown>);
    await db.completeTask(taskId, finalResult.answer, stats);
    return finalResult;
  };

  return runAgent();
}
