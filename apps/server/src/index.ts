import { existsSync } from "node:fs";
import { resolve } from "node:path";
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

const config = loadConfig();
const app = Fastify({
  logger: {
    level: config.NODE_ENV === "development" ? "debug" : "info"
  }
});
const db = new Database(config);

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: "Validation failed", issues: error.issues });
  }
  app.log.error(error);
  return reply.code(500).send({ error: "Internal server error" });
});

await app.register(cors, {
  origin: true,
  credentials: true
});
await app.register(cookie);

await db.init();
await seedAdminUser(db, config);
await registerPublicRoutes(app, db, config);
await registerAdminRoutes(app, db, config);

const adminDist = resolve(process.cwd(), config.ADMIN_DIST_DIR);
if (existsSync(adminDist)) {
  await app.register(staticPlugin, {
    root: adminDist,
    prefix: "/"
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/v1/") && !request.url.startsWith("/admin/api/")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not found" });
  });
}

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: "0.0.0.0", port: config.PORT });

