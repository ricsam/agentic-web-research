import { describe, expect, test } from "bun:test";
import { demoDefaults, clampDemoRequest, llmsTxt } from "./public";
import type { AppConfig } from "../config";

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 8080,
  PUBLIC_BASE_URL: "http://localhost:8080",
  DATABASE_URL: "postgres://example.invalid/test",
  APP_SECRET: "a-long-enough-application-secret",
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
};

describe("public demo research helpers", () => {
  test("builds demo defaults from config", () => {
    expect(demoDefaults(config)).toEqual({
      maxConcurrency: 2,
      maxDepth: 2,
      maxPages: 4,
      timeoutMs: 120000,
      pageTimeoutMs: 15000,
      allowPrivateNetworks: false
    });
  });

  test("clamps request limits to demo caps", () => {
    expect(clampDemoRequest({
      query: "test",
      maxConcurrency: 8,
      maxDepth: 8,
      maxPages: 32,
      timeoutMs: 300000
    }, config)).toEqual({
      query: "test",
      maxConcurrency: 2,
      maxDepth: 2,
      maxPages: 4,
      timeoutMs: 120000
    });
  });

  test("renders llms.txt docs with the configured public base URL", async () => {
    const docs = await llmsTxt(config, {
      headers: {},
      ip: "127.0.0.1"
    } as never);

    expect(docs).toContain("# agentic-web-research");
    expect(docs).toContain("http://localhost:8080/v1/research");
    expect(docs).not.toContain("<website>");
  });
});
