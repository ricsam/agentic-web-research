import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ResearchRequestSchema, type ResearchDefaults, type ResearchRequest } from "@agentic-web-research/core";
import type { AppConfig } from "../config";
import type { Database } from "../db/database";
import { verifyApiKey } from "../auth/keys";
import { runResearch } from "../research/engine";
import { FixedWindowRateLimiter } from "../utils/rateLimit";
import { createSseEmitter, prepareSse } from "../utils/sse";

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
    maxConcurrency: Math.min(request.maxConcurrency ?? config.DEMO_RESEARCH_MAX_CONCURRENCY, config.DEMO_RESEARCH_MAX_CONCURRENCY),
    maxDepth: Math.min(request.maxDepth ?? config.DEMO_RESEARCH_MAX_DEPTH, config.DEMO_RESEARCH_MAX_DEPTH),
    maxPages: Math.min(request.maxPages ?? config.DEMO_RESEARCH_MAX_PAGES, config.DEMO_RESEARCH_MAX_PAGES),
    timeoutMs: Math.min(request.timeoutMs ?? config.DEMO_RESEARCH_TIMEOUT_MS, config.DEMO_RESEARCH_TIMEOUT_MS)
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

export async function llmsTxt(config: AppConfig, request: FastifyRequest) {
  const template = await readFile(new URL("../../../../llms.txt", import.meta.url), "utf8");
  return template.replaceAll("<website>", publicBaseUrl(config, request));
}

export async function registerPublicRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const demoLimiter = new FixedWindowRateLimiter({
    max: config.DEMO_RESEARCH_RATE_LIMIT_MAX,
    windowMs: config.DEMO_RESEARCH_RATE_LIMIT_WINDOW_MS
  });
  app.get("/healthz", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });

  app.get("/llms.txt", async (request, reply) => {
    const docs = await llmsTxt(config, request);
    return reply
      .type("text/plain; charset=utf-8")
      .header("Cache-Control", "public, max-age=300")
      .send(docs);
  });

  app.get("/v1/demo/config", async () => {
    return {
      enabled: config.DEMO_RESEARCH_ENABLED,
      rateLimit: {
        max: config.DEMO_RESEARCH_RATE_LIMIT_MAX,
        windowMs: config.DEMO_RESEARCH_RATE_LIMIT_WINDOW_MS
      },
      defaults: demoDefaults(config)
    };
  });

  app.post("/v1/research", async (request, reply) => {
    const apiKey = await verifyApiKey(db, request.headers.authorization);
    if (!apiKey) {
      return reply.code(401).send({ error: "Invalid or missing API key" });
    }

    const body = ResearchRequestSchema.parse(request.body);
    const defaults = await db.getResearchDefaults();
    const taskId = await db.insertTask({ apiKeyId: apiKey.id, query: body.query, request: body });

    prepareSse(reply);
    const emit = createSseEmitter(db, reply, taskId);

    try {
      await runResearch({
        taskId,
        request: body,
        defaults,
        config,
        db,
        emit
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown research error";
      await db.failTask(taskId, message);
      await emit("error", { message });
    } finally {
      reply.raw.end();
    }

    return reply;
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
    const defaults = demoDefaults(config);
    const taskId = await db.insertTask({
      apiKeyId: null,
      query: requestWithDemoLimits.query,
      request: { ...requestWithDemoLimits, source: "public_demo" }
    });

    prepareSse(reply);
    const emit = createSseEmitter(db, reply, taskId);

    try {
      await runResearch({
        taskId,
        request: requestWithDemoLimits,
        defaults,
        config,
        db,
        emit
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown research error";
      await db.failTask(taskId, message);
      await emit("error", { message });
    } finally {
      reply.raw.end();
    }

    return reply;
  });
}

