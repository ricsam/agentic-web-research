import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  AdminLoginSchema,
  ApiKeyCreateSchema,
  LlmConfigSchema,
  ResearchDefaultsSchema
} from "@agentic-web-research/core";
import type { AppConfig } from "../config";
import type { Database } from "../db/database";
import {
  clearAdminCookie,
  requireAdmin,
  setAdminCookie,
  signAdminSession,
  verifyAdminCredentials
} from "../auth/admin";
import { createApiKey } from "../auth/keys";
import { searchWeb } from "../research/search";

export async function registerAdminRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
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
    const llm = await db.getLlmConfig();
    return {
      ...llm,
      apiKey: undefined,
      hasApiKey: Boolean(llm.apiKey)
    };
  });

  app.put("/admin/api/settings/llm", async (request, reply) => {
    const session = await requireAdmin(config, request, reply);
    if (!session) return;
    const body = LlmConfigSchema.partial({ apiKey: true }).parse(request.body);
    const existing = await db.getLlmConfig();
    await db.saveLlmConfig({
      ...existing,
      ...body,
      apiKey: body.apiKey || existing.apiKey
    });
    await db.log("info", "Updated LLM configuration", { admin: session.email, endpoint: body.endpoint, model: body.model });
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

    const checks = [];
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

    const llm = await db.getLlmConfig();
    checks.push({
      name: "llm_config",
      status: llm.apiKey ? "ok" : "degraded",
      message: llm.apiKey ? `${llm.model} at ${llm.endpoint}` : "LLM API key is not configured"
    });

    const status = checks.some((check) => check.status === "down")
      ? "down"
      : checks.some((check) => check.status === "degraded")
        ? "degraded"
        : "ok";
    return { status, checks, id: randomUUID() };
  });
}

