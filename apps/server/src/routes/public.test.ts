import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { demoDefaults, clampDemoRequest, createRequestAbortController, llmsTxt } from "./public";
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
  BOOTSTRAP_API_KEY: undefined,
  BOOTSTRAP_LLM_ENDPOINT: undefined,
  BOOTSTRAP_LLM_MODEL: undefined,
  BOOTSTRAP_LLM_API_KEY: undefined,
  BOOTSTRAP_LLM_HEADERS_JSON: "{}",
  BOOTSTRAP_LLM_TEMPERATURE: 0.2,
  BOOTSTRAP_LLM_MAX_OUTPUT_TOKENS: 4096,
  MAX_ACTIVE_RESEARCH_TASKS: 4,
  MAX_ACTIVE_PAGE_RENDERS: 8,
  CAPACITY_RETRY_AFTER_SECONDS: 10,
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
  test("aborts work when the response closes even if Node marks it ended", () => {
    const socket = new EventEmitter();
    const requestRaw = new EventEmitter();
    Object.assign(requestRaw, { socket });
    const replyRaw = new EventEmitter();
    Object.assign(replyRaw, { writableEnded: true });
    const controller = createRequestAbortController(
      { raw: requestRaw } as never,
      { raw: replyRaw } as never
    );

    replyRaw.emit("close");

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toEqual(new Error("Client disconnected"));
  });

  test("aborts work when the client socket closes", () => {
    const socket = new EventEmitter();
    const requestRaw = new EventEmitter();
    Object.assign(requestRaw, { socket });
    const replyRaw = new EventEmitter();
    const controller = createRequestAbortController(
      { raw: requestRaw } as never,
      { raw: replyRaw } as never
    );

    socket.emit("close");

    expect(controller.signal.aborted).toBe(true);
  });

  test("removes disconnect listeners only when route work explicitly completes", () => {
    const socket = new EventEmitter();
    const requestRaw = new EventEmitter();
    Object.assign(requestRaw, { socket });
    const replyRaw = new EventEmitter();
    const controller = createRequestAbortController(
      { raw: requestRaw } as never,
      { raw: replyRaw } as never
    );

    controller.cleanup();
    socket.emit("close");

    expect(controller.signal.aborted).toBe(false);
  });

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

  test("caps rendered page content and links", async () => {
    const { formatWebReadResult } = await import("./public");
    const result = formatWebReadResult({
      url: "https://example.com",
      finalUrl: "https://example.com/final",
      title: "Example",
      markdown: "x".repeat(40_001),
      links: Array.from({ length: 35 }, (_, index) => ({
        title: `Link ${index}`,
        url: `https://example.com/${index}`
      }))
    });

    expect(result.truncated).toBe(true);
    expect(result.markdown).toEndWith("[Content truncated]");
    expect(result.links).toHaveLength(30);
  });
});
