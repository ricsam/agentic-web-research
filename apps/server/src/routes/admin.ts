import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  AdminLoginSchema,
  ApiKeyCreateSchema,
  LlmActiveProviderSchema,
  OpenAiCompatibleProviderCreateSchema,
  OpenAiCompatibleProviderUpdateSchema,
  ResearchDefaultsSchema,
  ResearchRequestSchema
} from "@agentic-web-research/core";
import type { HealthStatus } from "@agentic-web-research/core";
import type { AppConfig } from "../config";
import type { Database } from "../db/database";
import { hasProviderCredentials } from "../db/database";
import {
  clearAdminCookie,
  requireAdmin,
  setAdminCookie,
  signAdminSession,
  verifyAdminCredentials
} from "../auth/admin";
import { createApiKey } from "../auth/keys";
import { runResearch } from "../research/engine";
import { searchWeb } from "../research/search";
import { createSseEmitter, prepareSse } from "../utils/sse";
import type { ResearchRuntime } from "../research/runtime";

export async function registerAdminRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
  runtime: ResearchRuntime
) {
  const secureCookies = config.NODE_ENV === "production";

  app.post("/admin/api/login", async (request, reply) => {
    const body = AdminLoginSchema.parse(request.body);
    const user = await verifyAdminCredentials(db, body.email, body.password);
    if (!user) return reply.code(401).send({ error: "Invalid credentials" });

    const token = await signAdminSession(config, { sub: user.id, email: user.email });
    setAdminCookie(reply, token, secureCookies);
    return { email: user.email };
  });

  app.post("/admin/api/logout", async (_request, reply) => {
    clearAdminCookie(reply, secureCookies);
    return { ok: true };
  });

  app.get("/admin/api/me", async (request, reply) => {
    const session = await requireAdmin(config, request, reply);
    if (!session) return;
    return { email: session.email };
  });

  app.get("/admin/api/settings/llm", async (request, reply) => {
    const session = await requireAdmin(config, request, reply);
    if (!session) return;
    return db.getPublicLlmSettings();
  });

  app.post("/admin/api/settings/llm/providers", async (request, reply) => {
    const session = await requireAdmin(config, request, reply);
    if (!session) return;
    const body = OpenAiCompatibleProviderCreateSchema.parse(request.body);
    const provider = await db.createLlmProvider(body);
    await db.log("info", "Created LLM provider", {
      admin: session.email,
      providerId: provider.id,
      providerName: provider.name,
      endpoint: provider.endpoint,
      model: provider.model,
      headerNames: Object.keys(provider.headers)
    });
    return reply.code(201).send({ ok: true, providerId: provider.id });
  });

  app.put("/admin/api/settings/llm/providers/:id", async (request, reply) => {
    const session = await requireAdmin(config, request, reply);
    if (!session) return;
    const id = (request.params as { id: string }).id;
    const body = OpenAiCompatibleProviderUpdateSchema.parse(request.body);
    const provider = await db.updateLlmProvider(id, body);
    if (!provider) return reply.code(404).send({ error: "Provider not found" });
    await db.log("info", "Updated LLM provider", {
      admin: session.email,
      providerId: provider.id,
      providerName: provider.name,
      endpoint: provider.endpoint,
      model: provider.model,
      headerNames: Object.keys(provider.headers)
    });
    return { ok: true };
  });

  app.delete("/admin/api/settings/llm/providers/:id", async (request, reply) => {
    const session = await requireAdmin(config, request, reply);
    if (!session) return;
    const id = (request.params as { id: string }).id;
    try {
      const deleted = await db.deleteLlmProvider(id);
      if (!deleted) return reply.code(404).send({ error: "Provider not found" });
    } catch (error) {
      if (error instanceof Error && error.message === "Cannot delete the active provider") {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
    await db.log("warn", "Deleted LLM provider", { admin: session.email, providerId: id });
    return { ok: true };
  });

  app.put("/admin/api/settings/llm/active", async (request, reply) => {
    const session = await requireAdmin(config, request, reply);
    if (!session) return;
    const { providerId } = LlmActiveProviderSchema.parse(request.body);
    const provider = await db.setActiveLlmProvider(providerId);
    if (!provider) return reply.code(404).send({ error: "Provider not found" });
    await db.log("info", "Changed active LLM provider", {
      admin: session.email,
      providerId: provider.id,
      providerName: provider.name,
      endpoint: provider.endpoint,
      model: provider.model
    });
    return { ok: true };
  });

  app.get("/admin/api/settings/research", async (request, reply) => {
    const session = await requireAdmin(config, request, reply);
    if (!session) return;
    return db.getResearchDefaults();
  });

  app.put("/admin/api/settings/research", async (request, reply) => {
    const session = await requireAdmin(config, request, reply);
    if (!session) return;
    const body = ResearchDefaultsSchema.parse(request.body);
    await db.saveResearchDefaults(body);
    await db.log("info", "Updated research defaults", { admin: session.email, defaults: body });
    return { ok: true };
  });

  app.get("/admin/api/api-keys", async (request, reply) => {
    const session = await requireAdmin(config, request, reply);
    if (!session) return;
    const result = await db.query(
      `SELECT id, name, prefix, created_at, last_used_at, revoked_at
       FROM api_keys
       ORDER BY created_at DESC`
    );
    return result.rows;
  });

  app.post("/admin/api/api-keys", async (request, reply) => {
    const session = await requireAdmin(config, request, reply);
    if (!session) return;
    const body = ApiKeyCreateSchema.parse(request.body);
    const apiKey = await createApiKey(db, body.name);
    await db.log("info", "Created API key", { admin: session.email, name: body.name, prefix: apiKey.prefix });
    return reply.code(201).send(apiKey);
  });

  app.delete("/admin/api/api-keys/:id", async (request, reply) => {
    const session = await requireAdmin(config, request, reply);
    if (!session) return;
    const id = (request.params as { id: string }).id;
    await db.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1", [id]);
    await db.log("warn", "Revoked API key", { admin: session.email, id });
    return { ok: true };
  });

  app.post("/admin/api/research-test", async (request, reply) => {
    const session = await requireAdmin(config, request, reply);
    if (!session) return;

    const body = ResearchRequestSchema.parse(request.body);
    if (!runtime.researchTasks.tryAcquire()) {
      return reply
        .code(429)
        .header("Retry-After", runtime.retryAfterSeconds)
        .send({ error: "Research service is at capacity", retryAfterSeconds: runtime.retryAfterSeconds });
    }
    const defaults = await db.getResearchDefaults();
    const taskId = await db.insertTask({
      apiKeyId: null,
      query: body.query,
      request: { ...body, source: "admin_test", admin: session.email }
    });
    await db.log("info", "Started admin research test", { admin: session.email, taskId, query: body.query });

    prepareSse(reply);
    const emit = createSseEmitter(db, reply, taskId);
    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort(new Error("Client disconnected")));

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
      await emit("error", { message });
    } finally {
      runtime.researchTasks.release();
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
    }

    return reply;
  });

  app.get("/admin/api/stats", async (request, reply) => {
    const session = await requireAdmin(config, request, reply);
    if (!session) return;
    return db.usageStats();
  });

  app.get("/admin/api/tasks", async (request, reply) => {
    const session = await requireAdmin(config, request, reply);
    if (!session) return;
    return db.recentTasks(50);
  });

  app.get("/admin/api/logs", async (request, reply) => {
    const session = await requireAdmin(config, request, reply);
    if (!session) return;
    return db.recentLogs(100);
  });

  app.get("/admin/api/health", async (request, reply) => {
    const session = await requireAdmin(config, request, reply);
    if (!session) return;

    const checks: Array<{ name: string; status: HealthStatus; message?: string; latencyMs?: number }> = [];
    const dbStart = Date.now();
    try {
      await db.query("SELECT 1");
      checks.push({ name: "postgres", status: "ok", latencyMs: Date.now() - dbStart });
    } catch (error) {
      checks.push({ name: "postgres", status: "down", message: error instanceof Error ? error.message : String(error) });
    }

    const searchStart = Date.now();
    try {
      await searchWeb(config.SEARXNG_URL, "health check");
      checks.push({ name: "searxng", status: "ok", latencyMs: Date.now() - searchStart });
    } catch (error) {
      checks.push({ name: "searxng", status: "degraded", message: error instanceof Error ? error.message : String(error) });
    }

    const activeProvider = await db.getActiveLlmProvider();
    const activeProviderHasAuth = activeProvider ? hasProviderCredentials(activeProvider) : false;
    checks.push({
      name: "llm_config",
      status: activeProvider && activeProviderHasAuth ? "ok" : "degraded",
      message: activeProvider
        ? activeProviderHasAuth
          ? `${activeProvider.name} (${activeProvider.model}) at ${activeProvider.endpoint}`
          : `${activeProvider.name} (${activeProvider.model}) at ${activeProvider.endpoint} is missing API key or auth headers`
        : "No active LLM provider is configured"
    });

    const status = checks.some((check) => check.status === "down")
      ? "down"
      : checks.some((check) => check.status === "degraded")
        ? "degraded"
        : "ok";
    return { status, checks, id: randomUUID() };
  });
}
