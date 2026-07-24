import { z } from "zod";

const HttpUrlSchema = z.string().url().refine((input) => {
  const protocol = new URL(input).protocol;
  return protocol === "http:" || protocol === "https:";
}, "URL must use http or https");

export const ResearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  sourceUrls: z.array(HttpUrlSchema).max(8).optional(),
  maxConcurrency: z.number().int().min(1).max(8).optional(),
  maxDepth: z.number().int().min(1).max(8).optional(),
  maxPages: z.number().int().min(1).max(32).optional(),
  timeoutMs: z.number().int().min(5000).max(300000).optional()
});

export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

export const WebSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  limit: z.number().int().min(1).max(10).default(5)
});

export type WebSearchRequest = z.infer<typeof WebSearchRequestSchema>;

export const WebReadRequestSchema = z.object({
  url: HttpUrlSchema
});

export type WebReadRequest = z.infer<typeof WebReadRequestSchema>;

export const ResearchDefaultsSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(8).default(2),
  maxDepth: z.number().int().min(1).max(8).default(3),
  maxPages: z.number().int().min(1).max(32).default(8),
  timeoutMs: z.number().int().min(5000).max(300000).default(120000),
  pageTimeoutMs: z.number().int().min(3000).max(60000).default(20000),
  allowPrivateNetworks: z.boolean().default(false)
});

export type ResearchDefaults = z.infer<typeof ResearchDefaultsSchema>;

const HeaderMapBaseSchema = z
  .record(z.string(), z.string())
  .superRefine((headers, context) => {
    const normalizedNames = new Set<string>();

    for (const name of Object.keys(headers)) {
      const normalized = name.trim().toLowerCase();
      if (!normalized) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "Header name cannot be empty"
        });
        continue;
      }

      if (normalizedNames.has(normalized)) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "Duplicate header name"
        });
        continue;
      }

      normalizedNames.add(normalized);
    }
  })
  .transform((headers) => {
    return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.trim(), value]));
  });

export const HeaderMapSchema = HeaderMapBaseSchema.default({});

const EndpointSchema = z.string().trim().url();
const ProviderNameSchema = z.string().trim().min(1).max(120);
const ProviderModelSchema = z.string().trim().min(1);
const TemperatureSchema = z.number().min(0).max(2);
const MaxOutputTokensSchema = z.number().int().min(256);
const OptionalIsoDateSchema = z.string().datetime().optional();

export const LlmConfigSchema = z.object({
  endpoint: EndpointSchema.default("https://api.openai.com/v1"),
  model: ProviderModelSchema.default("gpt-4.1-mini"),
  apiKey: z.string().optional(),
  headers: HeaderMapSchema,
  temperature: TemperatureSchema.default(0.2),
  maxOutputTokens: MaxOutputTokensSchema.default(4096)
});

export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export const OpenAiCompatibleProviderSchema = z.object({
  id: z.string().trim().min(1),
  name: ProviderNameSchema,
  endpoint: EndpointSchema,
  model: ProviderModelSchema,
  apiKey: z.string().optional(),
  headers: HeaderMapSchema,
  temperature: TemperatureSchema.default(0.2),
  maxOutputTokens: MaxOutputTokensSchema.default(4096),
  createdAt: OptionalIsoDateSchema,
  updatedAt: OptionalIsoDateSchema
});

export type OpenAiCompatibleProvider = z.infer<typeof OpenAiCompatibleProviderSchema>;

export const LlmSettingsSchema = z.object({
  activeProviderId: z.string().trim().min(1).optional(),
  providers: z.array(OpenAiCompatibleProviderSchema).default([])
});

export type LlmSettings = z.infer<typeof LlmSettingsSchema>;

export type PublicOpenAiCompatibleProvider = Omit<OpenAiCompatibleProvider, "apiKey" | "temperature"> & {
  hasApiKey: boolean;
};

export type PublicLlmSettings = {
  activeProviderId?: string;
  providers: PublicOpenAiCompatibleProvider[];
};

export const OpenAiCompatibleProviderCreateSchema = z.object({
  name: ProviderNameSchema,
  endpoint: EndpointSchema,
  model: ProviderModelSchema,
  apiKey: z.string().optional(),
  headers: HeaderMapSchema,
  temperature: TemperatureSchema.default(0.2),
  maxOutputTokens: MaxOutputTokensSchema.default(4096)
});

export type OpenAiCompatibleProviderCreate = z.infer<typeof OpenAiCompatibleProviderCreateSchema>;

export const OpenAiCompatibleProviderUpdateSchema = z.object({
  name: ProviderNameSchema.optional(),
  endpoint: EndpointSchema.optional(),
  model: ProviderModelSchema.optional(),
  apiKey: z.string().optional(),
  headers: HeaderMapBaseSchema.optional(),
  temperature: TemperatureSchema.optional(),
  maxOutputTokens: MaxOutputTokensSchema.optional()
});

export type OpenAiCompatibleProviderUpdate = z.infer<typeof OpenAiCompatibleProviderUpdateSchema>;

export const LlmActiveProviderSchema = z.object({
  providerId: z.string().trim().min(1)
});

export type LlmActiveProvider = z.infer<typeof LlmActiveProviderSchema>;

export const ApiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(120)
});

export type ApiKeyCreate = z.infer<typeof ApiKeyCreateSchema>;

export const AdminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

export type AdminLogin = z.infer<typeof AdminLoginSchema>;

export const researchEventTypes = [
  "search_started",
  "search_result",
  "page_fetch_started",
  "page_fetch_finished",
  "agent_thought",
  "answer_delta",
  "source",
  "final",
  "error"
] as const;

export type ResearchEventType = (typeof researchEventTypes)[number];

export type ResearchEvent = {
  type: ResearchEventType;
  taskId: string;
  at: string;
  payload: Record<string, unknown>;
};

export type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
  engine?: string;
  score?: number;
};

export type WebSearchResult = {
  query: string;
  results: SearchResult[];
};

export type WebPageLink = {
  title: string;
  url: string;
};

export type WebReadResult = {
  url: string;
  finalUrl: string;
  title: string;
  markdown: string;
  links: WebPageLink[];
  truncated: boolean;
};

export type ResearchSource = {
  url: string;
  title?: string;
  used: boolean;
};

export type ResearchFinalResult = {
  answer: string;
  sources: ResearchSource[];
  confidence?: "low" | "medium" | "high";
  notes?: string;
};

export type HealthStatus = "ok" | "degraded" | "down";

export type ServiceHealth = {
  status: HealthStatus;
  checks: Array<{
    name: string;
    status: HealthStatus;
    message?: string;
    latencyMs?: number;
  }>;
};
