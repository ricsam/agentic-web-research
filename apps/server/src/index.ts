import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import Fastify from "fastify";
import { ZodError } from "zod";
import { loadConfig } from "./config";
import { seedAdminUser } from "./auth/admin";
import { Database } from "./db/database";
import { registerAdminRoutes } from "./routes/admin";
import { registerPublicRoutes } from "./routes/public";
import { bootstrapServiceConfiguration } from "./bootstrap";
import { createResearchRuntime } from "./research/runtime";
import { UnsafeUrlError } from "./research/urlSafety";

const config = loadConfig();
const app = Fastify({
  logger: {
    level: config.NODE_ENV === "development" ? "debug" : "info"
  }
});
const db = new Database(config);

async function initDatabaseWithRetry(maxAttempts = 30) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await db.init();
      return;
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      const delayMs = Math.min(1000 * attempt, 5000);
      app.log.warn(
        { err: error, attempt, maxAttempts, delayMs },
        "Database initialization failed; retrying"
      );
      await setTimeout(delayMs);
    }
  }
}

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: "Validation failed", issues: error.issues });
  }
  if (error instanceof UnsafeUrlError) {
    return reply.code(400).send({ error: error.message });
  }
  if (error && typeof error === "object" && "code" in error && error.code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
    return reply.code(400).send({ error: "Request body must be omitted or contain valid JSON" });
  }
  app.log.error(error);
  return reply.code(500).send({ error: "Internal server error" });
});

await app.register(cors, {
  origin: true,
  credentials: true
});
await app.register(cookie);

await initDatabaseWithRetry();
await seedAdminUser(db, config);
await bootstrapServiceConfiguration(db, config);
const researchRuntime = createResearchRuntime(config);
await registerPublicRoutes(app, db, config, researchRuntime);
await registerAdminRoutes(app, db, config, researchRuntime);

const adminDist = resolve(process.cwd(), config.ADMIN_DIST_DIR);
const chartRepoDir = resolve(process.cwd(), config.CHART_REPO_DIR);

if (existsSync(chartRepoDir)) {
  await app.register(staticPlugin, {
    root: chartRepoDir,
    prefix: "/charts/",
    decorateReply: false,
    wildcard: false,
    setHeaders(response, pathName) {
      if (pathName.endsWith("index.yaml")) {
        response.setHeader("Content-Type", "application/x-yaml; charset=utf-8");
        response.setHeader("Cache-Control", "no-cache");
      }
    }
  });
}

if (existsSync(adminDist)) {
  await app.register(staticPlugin, {
    root: adminDist,
    prefix: "/"
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/v1/") && !request.url.startsWith("/admin/api/") && !request.url.startsWith("/charts/")) {
      return reply.sendFile("index.html", { maxAge: 0, immutable: false });
    }
    return reply.code(404).send({ error: "Not found" });
  });
}

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  await db.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ host: "0.0.0.0", port: config.PORT });
