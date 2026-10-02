import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { WebReadError } from "@agentic-web-research/core";
import { PageAccessError } from "./research/pageAccessError";
import { RequestLlmConfigError } from "./research/requestLlm";
import { UnsafeUrlError } from "./research/urlSafety";

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: "Validation failed", issues: error.issues });
    }
    if (error instanceof UnsafeUrlError) {
      return reply.code(400).send({ error: error.message });
    }
    if (error instanceof RequestLlmConfigError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    if (error instanceof PageAccessError) {
      // Target-site failures are not API authentication errors or service outages.
      // Return only the safe message/status, never URLs, upstream bodies or causes.
      const body: WebReadError = {
        error: error.message,
        code: error.code,
        upstreamStatus: error.upstreamStatus,
      };
      return reply.code(422).send(body);
    }
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
    ) {
      return reply
        .code(400)
        .send({ error: "Request body must be omitted or contain valid JSON" });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "Internal server error" });
  });
}
