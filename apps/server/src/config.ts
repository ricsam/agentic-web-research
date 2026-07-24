import { z } from "zod";

const optionalNonEmptyString = (schema: z.ZodType<string>) =>
  z.preprocess((value) => value === "" ? undefined : value, schema.optional());

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
  BOOTSTRAP_API_KEY: optionalNonEmptyString(z.string().min(20)),
  BOOTSTRAP_LLM_ENDPOINT: optionalNonEmptyString(z.string().url()),
  BOOTSTRAP_LLM_MODEL: optionalNonEmptyString(z.string().min(1)),
  BOOTSTRAP_LLM_API_KEY: optionalNonEmptyString(z.string().min(1)),
  BOOTSTRAP_LLM_HEADERS_JSON: z.string().default("{}"),
  BOOTSTRAP_LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  BOOTSTRAP_LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).default(4096),
  MAX_ACTIVE_RESEARCH_TASKS: z.coerce.number().int().min(1).max(64).default(4),
  MAX_ACTIVE_PAGE_RENDERS: z.coerce.number().int().min(1).max(64).default(8),
  CAPACITY_RETRY_AFTER_SECONDS: z.coerce.number().int().min(1).max(300).default(10),
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
}).superRefine((value, context) => {
  const hasBootstrapLlmConfig = Boolean(
    value.BOOTSTRAP_LLM_ENDPOINT ||
      value.BOOTSTRAP_LLM_MODEL ||
      value.BOOTSTRAP_LLM_API_KEY ||
      value.BOOTSTRAP_LLM_HEADERS_JSON !== "{}"
  );
  if (!hasBootstrapLlmConfig) return;

  if (!value.BOOTSTRAP_LLM_ENDPOINT) {
    context.addIssue({
      code: "custom",
      path: ["BOOTSTRAP_LLM_ENDPOINT"],
      message: "BOOTSTRAP_LLM_ENDPOINT is required when bootstrap LLM settings are provided"
    });
  }
  if (!value.BOOTSTRAP_LLM_MODEL) {
    context.addIssue({
      code: "custom",
      path: ["BOOTSTRAP_LLM_MODEL"],
      message: "BOOTSTRAP_LLM_MODEL is required when bootstrap LLM settings are provided"
    });
  }

  try {
    const headers = JSON.parse(value.BOOTSTRAP_LLM_HEADERS_JSON) as unknown;
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
      throw new Error("must be an object");
    }
    if (!Object.values(headers).every((entry) => typeof entry === "string")) {
      throw new Error("all values must be strings");
    }
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["BOOTSTRAP_LLM_HEADERS_JSON"],
      message: `BOOTSTRAP_LLM_HEADERS_JSON must be a JSON object with string values: ${error instanceof Error ? error.message : String(error)}`
    });
  }
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(): AppConfig {
  return EnvSchema.parse(process.env);
}

export function getBootstrapLlmHeaders(config: AppConfig): Record<string, string> {
  return JSON.parse(config.BOOTSTRAP_LLM_HEADERS_JSON) as Record<string, string>;
}
