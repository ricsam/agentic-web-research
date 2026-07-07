import { describe, expect, test } from "bun:test";
import { Database } from "./database";
import { encryptSecret } from "../utils/secrets";

const appSecret = "a-long-enough-application-secret";

function createDatabaseWithSetting(value: Record<string, unknown>) {
  const db = new Database({
    NODE_ENV: "test",
    PORT: 8080,
    PUBLIC_BASE_URL: "http://localhost:8080",
    DATABASE_URL: "postgres://example.invalid/test",
    APP_SECRET: appSecret,
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "change-me-now",
    SEARXNG_URL: "http://localhost:8081",
    ADMIN_DIST_DIR: "../admin/dist",
    CHART_REPO_DIR: "../../deploy/helm/repo",
    PLAYWRIGHT_HEADLESS: true,
    DEMO_RESEARCH_ENABLED: true,
    DEMO_RESEARCH_RATE_LIMIT_WINDOW_MS: 600000,
    DEMO_RESEARCH_RATE_LIMIT_MAX: 5,
    DEMO_RESEARCH_MAX_CONCURRENCY: 2,
    DEMO_RESEARCH_MAX_DEPTH: 2,
    DEMO_RESEARCH_MAX_PAGES: 4,
    DEMO_RESEARCH_PAGE_TIMEOUT_MS: 15000,
    DEMO_RESEARCH_TIMEOUT_MS: 120000
  });

  db.getSetting = async (_key, _fallback) => value as never;
  db.setSetting = async (_key, nextValue) => {
    value = nextValue as Record<string, unknown>;
  };

  return { db, getStoredValue: () => value };
}

describe("LLM provider settings database helpers", () => {
  test("normalizes legacy LLM config to provider settings", async () => {
    const { db } = createDatabaseWithSetting({
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      headers: { "X-Test": "yes" },
      temperature: 0.3,
      maxOutputTokens: 1024,
      apiKeyEncrypted: encryptSecret("sk-test", appSecret)
    });

    const settings = await db.getLlmSettings();

    expect(settings.activeProviderId).toBe("default");
    expect(settings.providers).toHaveLength(1);
    expect(settings.providers[0]).toMatchObject({
      id: "default",
      name: "Default",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      apiKey: "sk-test",
      headers: { "X-Test": "yes" },
      temperature: 0.3,
      maxOutputTokens: 1024
    });
  });

  test("public settings hide API keys and secret-bearing header values", async () => {
    const { db } = createDatabaseWithSetting({
      activeProviderId: "provider-1",
      providers: [
        {
          id: "provider-1",
          name: "Provider",
          endpoint: "https://api.example.com/v1",
          model: "model",
          headers: { Authorization: "Bearer secret", "X-Auth-Token": "token", "X-Trace": "visible" },
          temperature: 0.2,
          maxOutputTokens: 4096,
          apiKeyEncrypted: encryptSecret("sk-test", appSecret)
        }
      ]
    });

    const settings = await db.getPublicLlmSettings();

    expect(settings.providers[0].hasApiKey).toBe(true);
    expect(settings.providers[0]).not.toHaveProperty("apiKey");
    expect(settings.providers[0]).not.toHaveProperty("apiKeyEncrypted");
    expect(settings.providers[0].headers).toEqual({ Authorization: "", "X-Auth-Token": "", "X-Trace": "visible" });
  });

  test("updating provider preserves encrypted API key when API key omitted", async () => {
    const { db, getStoredValue } = createDatabaseWithSetting({
      activeProviderId: "provider-1",
      providers: [
        {
          id: "provider-1",
          name: "Provider",
          endpoint: "https://api.example.com/v1",
          model: "model",
          headers: {},
          temperature: 0.2,
          maxOutputTokens: 4096,
          apiKeyEncrypted: encryptSecret("sk-test", appSecret)
        }
      ]
    });

    await db.updateLlmProvider("provider-1", { model: "next-model" });

    const stored = getStoredValue();
    expect(Array.isArray(stored.providers)).toBe(true);
    expect((stored.providers as unknown[]).length).toBe(1);
    const provider = (stored.providers as Array<Record<string, unknown>>)[0];
    expect(provider.model).toBe("next-model");
    expect(typeof provider.apiKeyEncrypted).toBe("string");
    expect(JSON.stringify(stored)).not.toContain("sk-test");

    const active = await db.getActiveLlmProvider();
    expect(active?.apiKey).toBe("sk-test");
  });
});
