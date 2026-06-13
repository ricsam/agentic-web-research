import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import type { ResearchDefaults, ResearchFinalResult, ResearchRequest, SearchResult } from "@agentic-web-research/core";
import type { AppConfig } from "../config";
import type { Database } from "../db/database";
import type { SseEmitter } from "../utils/sse";
import { Semaphore } from "../utils/semaphore";
import { WebRenderer } from "./renderer";
import { searchWeb } from "./search";

export type ResearchRunInput = {
  taskId: string;
  request: ResearchRequest;
  defaults: ResearchDefaults;
  config: AppConfig;
  db: Database;
  emit: SseEmitter;
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
    allowPrivateNetworks: defaults.allowPrivateNetworks
  };
}

function formatSearchResults(results: SearchResult[]) {
  return results
    .map((result, index) => {
      return [
        `${index + 1}. ${result.title}`,
        `URL: ${result.url}`,
        result.snippet ? `Snippet: ${result.snippet}` : undefined
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function trimMarkdown(markdown: string) {
  const maxChars = 45000;
  return markdown.length > maxChars ? `${markdown.slice(0, maxChars)}\n\n[Content truncated]` : markdown;
}

export async function runResearch(input: ResearchRunInput) {
  const { taskId, request, defaults, config, db, emit } = input;
  const options = mergeOptions(request, defaults);
  const stats: RunStats = {
    pagesRendered: 0,
    toolCalls: 0,
    startedAt: new Date().toISOString()
  };
  const deadline = Date.now() + options.timeoutMs;

  await emit("search_started", { query: request.query });
  const searchResults = await searchWeb(config.SEARXNG_URL, request.query);
  stats.searchedAt = new Date().toISOString();

  for (const result of searchResults) {
    await emit("search_result", result);
  }

  const llm = await db.getLlmConfig();
  if (!llm.apiKey) {
    throw new Error("LLM API key is not configured");
  }

  const renderer = new WebRenderer(config.PLAYWRIGHT_HEADLESS);
  const semaphore = new Semaphore(options.maxConcurrency);
  const depths = new Map<string, number>();
  const renderedSources = new Map<string, { title?: string; used: boolean }>();
  let submitted: ResearchFinalResult | null = null;
  let accumulatedAnswer = "";

  for (const result of searchResults) {
    depths.set(result.url, 1);
  }

  try {
    const provider = createOpenAICompatible({
      name: "admin-configured",
      apiKey: llm.apiKey,
      baseURL: llm.endpoint,
      headers: llm.headers
    });

    const result = streamText({
      model: provider(llm.model),
      temperature: llm.temperature,
      maxOutputTokens: llm.maxOutputTokens,
      stopWhen: stepCountIs(Math.min(options.maxPages + options.maxDepth + 4, 16)),
      system:
        "You are a focused web research agent. Use the provided search results and page-viewing tool to gather enough evidence. " +
        "Prefer authoritative primary sources. Do not invent sources. When you have enough information, call submit_research_result with a concise answer and source list.",
      prompt: [
        `Research query: ${request.query}`,
        "",
        `Limits: max ${options.maxPages} rendered pages, max navigation depth ${options.maxDepth}, max ${options.maxConcurrency} concurrent page renders.`,
        "",
        "Initial search results:",
        searchResults.length ? formatSearchResults(searchResults) : "No search results were returned."
      ].join("\n"),
      tools: {
        view_page: tool({
          description:
            "Render a web page, convert the readable page content to Markdown, and return useful links for further navigation.",
          inputSchema: z.object({
            url: z.string().url(),
            reason: z.string().min(1).max(500),
            sourceUrl: z.string().url().optional()
          }),
          execute: async ({ url, reason, sourceUrl }) => {
            if (Date.now() > deadline) {
              return { error: "Research task timed out" };
            }
            if (stats.pagesRendered >= options.maxPages) {
              return { error: `Page limit reached (${options.maxPages})` };
            }

            const sourceDepth = sourceUrl ? depths.get(sourceUrl) ?? 1 : 0;
            const depth = sourceUrl ? sourceDepth + 1 : depths.get(url) ?? 1;
            if (depth > options.maxDepth) {
              return { error: `Navigation depth ${depth} exceeds maxDepth ${options.maxDepth}` };
            }

            stats.toolCalls += 1;
            stats.pagesRendered += 1;
            await emit("page_fetch_started", { url, reason, depth });

            try {
              const rendered = await semaphore.run(() =>
                renderer.render(url, {
                  timeoutMs: options.pageTimeoutMs,
                  allowPrivateNetworks: options.allowPrivateNetworks
                })
              );
              depths.set(rendered.finalUrl, depth);
              depths.set(url, depth);
              renderedSources.set(rendered.finalUrl, { title: rendered.title, used: true });

              await emit("page_fetch_finished", {
                url: rendered.finalUrl,
                title: rendered.title,
                markdownLength: rendered.markdown.length,
                links: rendered.links.length
              });

              return {
                url: rendered.finalUrl,
                title: rendered.title,
                depth,
                markdown: trimMarkdown(rendered.markdown),
                links: rendered.links.slice(0, 30)
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : "Unknown render error";
              await emit("error", { url, message });
              return { error: message };
            }
          }
        }),
        submit_research_result: tool({
          description: "Submit the final research answer and stop researching.",
          inputSchema: z.object({
            answer: z.string().min(1),
            sources: z.array(
              z.object({
                url: z.string().url(),
                title: z.string().optional(),
                used: z.boolean().default(true)
              })
            ),
            confidence: z.enum(["low", "medium", "high"]).optional(),
            notes: z.string().optional()
          }),
          execute: async (finalResult) => {
            submitted = finalResult;
            await emit("source", { sources: finalResult.sources });
            return { accepted: true };
          }
        })
      }
    });

    for await (const part of result.fullStream as AsyncIterable<Record<string, unknown>>) {
      if (part.type === "text-delta") {
        const text = typeof part.text === "string" ? part.text : typeof part.delta === "string" ? part.delta : "";
        if (text) {
          accumulatedAnswer += text;
          await emit("answer_delta", { text });
        }
      }

      if (part.type === "tool-call") {
        await emit("agent_thought", {
          tool: part.toolName,
          args: part.input ?? part.args ?? {}
        });
      }

      if (part.type === "error") {
        const error = part.error instanceof Error ? part.error.message : String(part.error ?? "Unknown AI SDK error");
        throw new Error(error);
      }
    }

    const fallbackSources = Array.from(renderedSources.entries()).map(([url, source]) => ({
      url,
      title: source.title,
      used: source.used
    }));
    const finalResult: ResearchFinalResult =
      submitted ??
      ({
        answer: accumulatedAnswer.trim() || "The agent did not produce a final answer.",
        sources: fallbackSources,
        confidence: "low",
        notes: "The model ended without calling submit_research_result."
      } satisfies ResearchFinalResult);

    stats.finishedAt = new Date().toISOString();
    await emit("final", finalResult as unknown as Record<string, unknown>);
    await db.completeTask(taskId, finalResult.answer, stats);
    return finalResult;
  } finally {
    await renderer.close();
  }
}

