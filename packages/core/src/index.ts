import { z } from "zod";

export const ResearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  maxConcurrency: z.number().int().min(1).max(8).optional(),
  maxDepth: z.number().int().min(1).max(8).optional(),
  maxPages: z.number().int().min(1).max(32).optional(),
  timeoutMs: z.number().int().min(5000).max(300000).optional()
});

export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

export const ResearchDefaultsSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(8).default(2),
  maxDepth: z.number().int().min(1).max(8).default(3),
  maxPages: z.number().int().min(1).max(32).default(8),
  timeoutMs: z.number().int().min(5000).max(300000).default(120000),
  pageTimeoutMs: z.number().int().min(3000).max(60000).default(20000),
  allowPrivateNetworks: z.boolean().default(false)
});

export type ResearchDefaults = z.infer<typeof ResearchDefaultsSchema>;

export const LlmConfigSchema = z.object({
  endpoint: z.string().url().default("https://api.openai.com/v1"),
  model: z.string().trim().min(1).default("gpt-4.1-mini"),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  temperature: z.number().min(0).max(2).default(0.2),
  maxOutputTokens: z.number().int().min(256).max(32000).default(4096)
});

export type LlmConfig = z.infer<typeof LlmConfigSchema>;

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

