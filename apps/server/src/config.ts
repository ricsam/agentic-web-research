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
  CHART_REPO_DIR: z.string().default("../../deploy/helm/repo"),
  PLAYWRIGHT_HEADLESS: z
    .preprocess((value) => (value === undefined ? true : value !== "false"), z.boolean())
    .default(true),
  DEMO_RESEARCH_ENABLED: z
    .preprocess((value) => (value === undefined ? true : value !== "false"), z.boolean())
    .default(true),
  DEMO_RESEARCH_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .default(600000),
  DEMO_RESEARCH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(5),
  DEMO_RESEARCH_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  DEMO_RESEARCH_MAX_DEPTH: z.coerce.number().int().min(1).max(8).default(2),
  DEMO_RESEARCH_MAX_PAGES: z.coerce.number().int().min(1).max(32).default(4),
  DEMO_RESEARCH_PAGE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(3000)
    .max(60000)
    .default(15000),
  DEMO_RESEARCH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(5000)
    .max(300000)
    .default(120000)
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(): AppConfig {
  return EnvSchema.parse(process.env);
}
