import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8080"),
  DATABASE_URL: z.string().min(1),
  APP_SECRET: z.string().min(16),
  ADMIN_EMAIL: z.string().email().default("admin@example.com"),
  ADMIN_PASSWORD: z.string().min(8).default("change-me-now"),
  SEARXNG_URL: z.string().url().default("http://localhost:8081"),
  ADMIN_DIST_DIR: z.string().default("../admin/dist"),
  PLAYWRIGHT_HEADLESS: z
    .preprocess((value) => (value === undefined ? true : value !== "false"), z.boolean())
    .default(true)
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(): AppConfig {
  return EnvSchema.parse(process.env);
}
