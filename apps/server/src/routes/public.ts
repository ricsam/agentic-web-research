import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ResearchRequestSchema,
  WebReadRequestSchema,
  WebSearchRequestSchema,
  type ResearchDefaults,
  type ResearchRequest,
  type WebReadResult
} from "@agentic-web-research/core";
import type { AppConfig } from "../config";
import type { Database } from "../db/database";
import { hasProviderCredentials } from "../db/database";
import { verifyApiKey } from "../auth/keys";
import { runResearch } from "../research/engine";
import { WebRenderer } from "../research/renderer";
import type { ResearchRuntime } from "../research/runtime";
import { searchWeb } from "../research/search";
import { FixedWindowRateLimiter } from "../utils/rateLimit";
import { createSseEmitter, prepareSse } from "../utils/sse";

const MAX_READ_MARKDOWN_CHARS = 40_000;
const MAX_READ_LINKS = 30;

export function demoDefaults(config: AppConfig): ResearchDefaults {
  return {
    maxConcurrency: config.DEMO_RESEARCH_MAX_CONCURRENCY,
    maxDepth: config.DEMO_RESEARCH_MAX_DEPTH,
    maxPages: config.DEMO_RESEARCH_MAX_PAGES,
    timeoutMs: config.DEMO_RESEARCH_TIMEOUT_MS,
    pageTimeoutMs: config.DEMO_RESEARCH_PAGE_TIMEOUT_MS,
    allowPrivateNetworks: false
  };
}

export function clampDemoRequest(request: ResearchRequest, config: AppConfig): ResearchRequest {
  return {
    query: request.query,
    ...(request.sourceUrls ? { sourceUrls: request.sourceUrls } : {}),
    maxConcurrency: Math.min(request.maxConcurrency ?? config.DEMO_RESEARCH_MAX_CONCURRENCY, config.DEMO_RESEARCH_MAX_CONCURRENCY),
    maxDepth: Math.min(request.maxDepth ?? config.DEMO_RESEARCH_MAX_DEPTH, config.DEMO_RESEARCH_MAX_DEPTH),
    maxPages: Math.min(request.maxPages ?? config.DEMO_RESEARCH_MAX_PAGES, config.DEMO_RESEARCH_MAX_PAGES),
    timeoutMs: Math.min(request.timeoutMs ?? config.DEMO_RESEARCH_TIMEOUT_MS, config.DEMO_RESEARCH_TIMEOUT_MS)
  };
}

export function formatWebReadResult(rendered: Awaited<ReturnType<WebRenderer["render"]>>): WebReadResult {
  const truncated = rendered.markdown.length > MAX_READ_MARKDOWN_CHARS;
  return {
    url: rendered.url,
    finalUrl: rendered.finalUrl,
    title: rendered.title,
    markdown: truncated
      ? `${rendered.markdown.slice(0, MAX_READ_MARKDOWN_CHARS)}\n\n[Content truncated]`
      : rendered.markdown,
    links: rendered.links.slice(0, MAX_READ_LINKS),
    truncated
  };
}

function clientIdentity(request: FastifyRequest) {
  return request.ip;
}

function publicBaseUrl(config: AppConfig, request: FastifyRequest) {
  if (config.PUBLIC_BASE_URL) return config.PUBLIC_BASE_URL.replace(/\/$/, "");
  const protocol = request.headers["x-forwarded-proto"]?.toString().split(",")[0]?.trim() || "http";
  const host = request.headers.host || `localhost:${config.PORT}`;
  return `${protocol}://${host}`;
}

function createRequestAbortController(request: FastifyRequest, reply: FastifyReply) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new Error("Client disconnected"));
  };
  request.raw.once("aborted", abort);
  reply.raw.once("close", () => {
    if (!reply.raw.writableEnded) abort();
  });
  return controller;
}

function sendCapacityError(reply: FastifyReply, runtime: ResearchRuntime) {
  return reply
    .code(429)
    .header("Retry-After", runtime.retryAfterSeconds)
    .send({ error: "Research service is at capacity", retryAfterSeconds: runtime.retryAfterSeconds });
}

async function requireApiKey(request: FastifyRequest, reply: FastifyReply, db: Database) {
  const apiKey = await verifyApiKey(db, request.headers.authorization);
  if (!apiKey) {
    await reply.code(401).send({ error: "Invalid or missing API key" });
    return null;
  }
  return apiKey;
}

async function runResearchSse(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  db: Database;
  config: AppConfig;
  runtime: ResearchRuntime;
  body: ResearchRequest;
  defaults: ResearchDefaults;
  apiKeyId: string | null;
  requestMetadata?: Record<string, unknown>;
}) {
  const { request, reply, db, config, runtime, body, defaults, apiKeyId, requestMetadata } = input;
  if (!runtime.researchTasks.tryAcquire()) {
    return sendCapacityError(reply, runtime);
  }

  const controller = createRequestAbortController(request, reply);
  const taskId = await db.insertTask({
    apiKeyId,
    query: body.query,
    request: requestMetadata ? { ...body, ...requestMetadata } : body
  });
  prepareSse(reply);
  const emit = createSseEmitter(db, reply, taskId);

  try {
    await runResearch({
      taskId,
      request: body,
      defaults,
      config,
      db,
      emit,
      runtime,
      signal: controller.signal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown research error";
    await db.failTask(taskId, message);
    if (!controller.signal.aborted) {
      await emit("error", { message });
    }
  } finally {
    runtime.researchTasks.release();
    if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
  }

  return reply;
}

export async function llmsTxt(config: AppConfig, request: FastifyRequest) {
  const template = await readFile(new URL("../../../../llms.txt", import.meta.url), "utf8");
  return template.replaceAll("<website>", publicBaseUrl(config, request));
}

export async function registerPublicRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
  runtime: ResearchRuntime
) {
  const demoLimiter = new FixedWindowRateLimiter({
    max: config.DEMO_RESEARCH_RATE_LIMIT_MAX,
    windowMs: config.DEMO_RESEARCH_RATE_LIMIT_WINDOW_MS
  });
  let readinessCache: { checkedAt: number; body: Record<string, unknown>; status: number } | null = null;

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_request, reply) => {
    if (readinessCache && Date.now() - readinessCache.checkedAt < 30_000) {
      return reply.code(readinessCache.status).send(readinessCache.body);
    }

    const checks: Record<string, { ok: boolean; message?: string }> = {};
    try {
      await db.query("SELECT 1");
      checks.database = { ok: true };
    } catch (error) {
      checks.database = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }

    try {
      const response = await fetch(config.SEARXNG_URL, { signal: AbortSignal.timeout(3_000) });
      checks.searxng = response.ok ? { ok: true } : { ok: false, message: `HTTP ${response.status}` };
    } catch (error) {
      checks.searxng = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }

    const renderer = new WebRenderer(config.PLAYWRIGHT_HEADLESS);
    try {
      checks.browser = (await renderer.checkAvailability()) ? { ok: true } : { ok: false, message: "Browser disconnected" };
    } catch (error) {
      checks.browser = { ok: false, message: error instanceof Error ? error.message : String(error) };
    } finally {
      await renderer.close().catch(() => undefined);
    }

    const provider = await db.getActiveLlmProvider();
    checks.llm = provider && hasProviderCredentials(provider)
      ? { ok: true }
      : { ok: false, message: provider ? "Active provider has no credentials" : "No active provider configured" };

    const ok = Object.values(checks).every((check) => check.ok);
    const body = { ok, checks };
    const status = ok ? 200 : 503;
    readinessCache = { checkedAt: Date.now(), body, status };
    return reply.code(status).send(body);
  });

  app.get("/llms.txt", async (request, reply) => {
    const docs = await llmsTxt(config, request);
    return reply
      .type("text/plain; charset=utf-8")
      .header("Cache-Control", "public, max-age=300")
      .send(docs);
  });

  app.post("/v1/search", async (request, reply) => {
    if (!(await requireApiKey(request, reply, db))) return reply;
    const body = WebSearchRequestSchema.parse(request.body);
    const controller = createRequestAbortController(request, reply);
    const results = await searchWeb(config.SEARXNG_URL, body.query, {
      limit: body.limit,
      signal: controller.signal
    });
    return { query: body.query, results };
  });

  app.post("/v1/read", async (request, reply) => {
    if (!(await requireApiKey(request, reply, db))) return reply;
    const body = WebReadRequestSchema.parse(request.body);
    const controller = createRequestAbortController(request, reply);
    const defaults = await db.getResearchDefaults();
    const attempt = await runtime.pageRenders.tryRun(async () => {
      const renderer = new WebRenderer(config.PLAYWRIGHT_HEADLESS);
      try {
        const rendered = await renderer.render(body.url, {
          timeoutMs: defaults.pageTimeoutMs,
          allowPrivateNetworks: false,
          signal: controller.signal
        });
        return formatWebReadResult(rendered);
      } finally {
        await renderer.close();
      }
    });
    if (!attempt.accepted) return sendCapacityError(reply, runtime);
    return attempt.value;
  });

  app.get("/v1/demo/config", async () => ({
    enabled: config.DEMO_RESEARCH_ENABLED,
    rateLimit: {
      max: config.DEMO_RESEARCH_RATE_LIMIT_MAX,
      windowMs: config.DEMO_RESEARCH_RATE_LIMIT_WINDOW_MS
    },
    defaults: demoDefaults(config)
  }));

  app.post("/v1/research", async (request, reply) => {
    const apiKey = await requireApiKey(request, reply, db);
    if (!apiKey) return reply;
    const body = ResearchRequestSchema.parse(request.body);
    return runResearchSse({
      request,
      reply,
      db,
      config,
      runtime,
      body,
      defaults: await db.getResearchDefaults(),
      apiKeyId: apiKey.id
    });
  });

  app.post("/v1/demo/research", async (request, reply) => {
    if (!config.DEMO_RESEARCH_ENABLED) {
      return reply.code(404).send({ error: "Demo research is disabled" });
    }

    const body = ResearchRequestSchema.parse(request.body);
    const rateLimit = demoLimiter.check(clientIdentity(request));
    reply.raw.setHeader("X-RateLimit-Limit", rateLimit.limit);
    reply.raw.setHeader("X-RateLimit-Remaining", rateLimit.remaining);
    reply.raw.setHeader("X-RateLimit-Reset", rateLimit.resetAt.toISOString());

    if (!rateLimit.allowed) {
      reply.raw.setHeader("Retry-After", Math.ceil(rateLimit.retryAfterMs / 1000));
      return reply.code(429).send({
        error: "Demo rate limit exceeded",
        retryAfterMs: rateLimit.retryAfterMs,
        resetAt: rateLimit.resetAt.toISOString()
      });
    }

    const requestWithDemoLimits = clampDemoRequest(body, config);
    return runResearchSse({
      request,
      reply,
      db,
      config,
      runtime,
      body: requestWithDemoLimits,
      defaults: demoDefaults(config),
      apiKeyId: null,
      requestMetadata: { source: "public_demo" }
    });
  });
}
