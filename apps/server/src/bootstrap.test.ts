import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { AppConfig } from "./config";
import type { Database } from "./db/database";
import { bootstrapServiceConfiguration } from "./bootstrap";

function config(token: string, llmApiKey: string): AppConfig {
  return {
    BOOTSTRAP_API_KEY: token,
    BOOTSTRAP_LLM_ENDPOINT: "https://models.example.com/v1",
    BOOTSTRAP_LLM_MODEL: "research-model",
    BOOTSTRAP_LLM_API_KEY: llmApiKey,
    BOOTSTRAP_LLM_HEADERS_JSON: "{}",
    BOOTSTRAP_LLM_TEMPERATURE: 0.2,
    BOOTSTRAP_LLM_MAX_OUTPUT_TOKENS: 4096
  } as AppConfig;
}

describe("service configuration bootstrap", () => {
  test("upserts stable records and rotates service and model tokens", async () => {
    const queries: unknown[][] = [];
    const providers: Array<Record<string, unknown>> = [];
    const db = {
      query: async (_sql: string, values: unknown[]) => {
        queries.push(values);
        return { rows: [] };
      },
      upsertBootstrapLlmProvider: async (provider: Record<string, unknown>) => {
        providers.push(provider);
      }
    } as unknown as Database;

    await bootstrapServiceConfiguration(db, config("first-service-token-value", "first-model-token"));
    await bootstrapServiceConfiguration(db, config("second-service-token-value", "second-model-token"));

    expect(queries.map((values) => values[0])).toEqual(["r5d-platform", "r5d-platform"]);
    expect(queries[0]?.[2]).toBe(createHash("sha256").update("first-service-token-value").digest("hex"));
    expect(queries[1]?.[2]).toBe(createHash("sha256").update("second-service-token-value").digest("hex"));
    expect(providers.map((provider) => provider.id)).toEqual(["r5d-platform", "r5d-platform"]);
    expect(providers[1]?.apiKey).toBe("second-model-token");
  });
});
