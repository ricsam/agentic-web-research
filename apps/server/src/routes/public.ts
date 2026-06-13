import type { FastifyInstance } from "fastify";
import { ResearchRequestSchema } from "@agentic-web-research/core";
import type { AppConfig } from "../config";
import type { Database } from "../db/database";
import { verifyApiKey } from "../auth/keys";
import { runResearch } from "../research/engine";
import { createSseEmitter, prepareSse } from "../utils/sse";

export async function registerPublicRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  app.get("/healthz", async () => {
    await db.query("SELECT 1");
    return { ok: true };
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
}

