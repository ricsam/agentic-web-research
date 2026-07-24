import type { FastifyReply } from "fastify";
import type { ResearchEvent, ResearchEventType } from "@agentic-web-research/core";
import type { Database } from "../db/database";

export type SseEmitter = (type: ResearchEventType, payload: Record<string, unknown>) => Promise<void>;

export function prepareSse(reply: FastifyReply) {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  reply.raw.write(": connected\n\n");
}

export function createSseEmitter(db: Database, reply: FastifyReply, taskId: string): SseEmitter {
  return async (type, payload) => {
    const event: ResearchEvent = {
      type,
      taskId,
      at: new Date().toISOString(),
      payload
    };
    await db.addResearchEvent(taskId, type, payload);
    if (reply.raw.destroyed || reply.raw.writableEnded) return;
    reply.raw.write(`event: ${type}\n`);
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
}
