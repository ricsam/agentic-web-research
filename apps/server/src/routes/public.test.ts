import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { ResearchDefaultsSchema } from "@agentic-web-research/core";
import { hashApiKey } from "../auth/keys";
import type { Database } from "../db/database";
import { registerErrorHandler } from "../errorHandler";
import { createResearchRuntime } from "../research/runtime";
import type { WebRenderer } from "../research/renderer";
import {
  cancelResearchLease,
  demoDefaults,
  clampDemoRequest,
  createRequestAbortController,
  llmsTxt,
  registerResearchLease,
  registerPublicRoutes,
  waitForResearchAbort,
} from "./public";
import type { AppConfig } from "../config";
import {
  parseRequestLlmConfig,
  requestLlmHeaderNames,
} from "../research/requestLlm";

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
  REQUEST_LLM_CONFIG_MODE: "optional",
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
  DEMO_RESEARCH_TIMEOUT_MS: 120000,
};

const testApiKey = "awr_read-route-test-only";

async function readRouteHarness() {
  const app = Fastify();
  registerErrorHandler(app);
  const db = {
    query: async (sql: string, params: unknown[]) => ({
      rows: sql.includes("SELECT") && params[0] === hashApiKey(testApiKey)
        ? [{ id: "read-test-key", name: "Test", prefix: "awr_read" }]
        : []
    }),
    getResearchDefaults: async () => ResearchDefaultsSchema.parse({})
  } as unknown as Database;
  const runtime = createResearchRuntime(config);
  await registerPublicRoutes(app, db, config, runtime);
  app.addHook("onClose", async () => { await runtime.renderer.close(); });
  return { app, runtime };
}

// Run the real renderer fallback against a local fixture without weakening the
// production route's private-network restriction or making external requests.
function useLocalFetchFixture(renderer: WebRenderer) {
  const render = renderer.render.bind(renderer);
  renderer.render = (url, options) => {
    expect(options.allowPrivateNetworks).toBe(false);
    return render(url, { ...options, allowPrivateNetworks: true });
  };
  (renderer as unknown as { renderWithBrowser: () => Promise<never> }).renderWithBrowser = async () => {
    throw new Error("Page did not contain meaningful readable article content after rendering");
  };
}

function readRequest(url: string) {
  return {
    method: "POST" as const,
    url: "/v1/read",
    headers: { authorization: `Bearer ${testApiKey}` },
    payload: { url }
  };
}

const upstreamErrors = [
  [401, "Page requires authentication (HTTP 401)."],
  [403, "Page access denied (HTTP 403); the site may require authentication or block automated access."],
  [404, "Page unavailable (HTTP 404); it may be private or missing."],
  [429, "Page unavailable (HTTP 429); the target site returned an unsuccessful response."],
  [500, "Page unavailable (HTTP 500); the target site returned an unsuccessful response."],
  [503, "Page unavailable (HTTP 503); the target site returned an unsuccessful response."]
] as const;

describe("POST /v1/read", () => {
  test.each(upstreamErrors)("reports target HTTP %i as a structured 422, not a service failure", async (status, message) => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("Upstream body must not be exposed", { status })
    });
    const { app, runtime } = await readRouteHarness();
    useLocalFetchFixture(runtime.renderer);
    try {
      const response = await app.inject(readRequest(server.url.toString()));
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
        error: message,
        code: "PAGE_ACCESS_ERROR",
        upstreamStatus: status
      });
      expect(runtime.pageRenders.activeCount).toBe(0);
    } finally {
      await app.close();
      await server.stop(true);
    }
  });

  test("returns readable content unchanged after successful fallback", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(
        '<main><h1>Readable document</h1><p>This page contains meaningful readable article content.</p><a href="/next">Next page</a></main>',
        { headers: { "content-type": "text/html" } }
      )
    });
    const { app, runtime } = await readRouteHarness();
    useLocalFetchFixture(runtime.renderer);
    try {
      const response = await app.inject(readRequest(server.url.toString()));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        url: server.url.toString(),
        finalUrl: server.url.toString(),
        title: "Readable document",
        markdown: expect.stringContaining("This page contains meaningful readable article content."),
        links: [{ title: "Next page", url: new URL("/next", server.url).toString() }],
        truncated: false
      });
      expect(runtime.pageRenders.activeCount).toBe(0);
    } finally {
      await app.close();
      await server.stop(true);
    }
  });

  test("keeps unexpected errors generic and releases render capacity", async () => {
    const { app, runtime } = await readRouteHarness();
    runtime.renderer.render = async () => { throw new Error("unexpected internal detail"); };
    try {
      const response = await app.inject(readRequest("https://example.com/"));
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "Internal server error" });
      expect(runtime.pageRenders.activeCount).toBe(0);
    } finally {
      await app.close();
    }
  });

  test("keeps API authentication, validation and URL-safety failures distinct", async () => {
    const { app } = await readRouteHarness();
    try {
      const unauthenticated = await app.inject({ ...readRequest("https://example.com/"), headers: {} });
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.json()).toEqual({ error: "Invalid or missing API key" });
      const invalid = await app.inject(readRequest("ftp://example.com/"));
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error).toBe("Validation failed");
      const unsafe = await app.inject(readRequest("http://127.0.0.1/"));
      expect(unsafe.statusCode).toBe(400);
      expect(unsafe.json()).toEqual({ error: "Private network URLs are disabled" });
    } finally {
      await app.close();
    }
  });
});

describe("request-scoped LLM headers", () => {
  test("parses a complete ephemeral override", () => {
    const request = {
      headers: {
        [requestLlmHeaderNames.endpoint]: "https://models.example.com/v1",
        [requestLlmHeaderNames.model]: "managed-model",
        [requestLlmHeaderNames.apiKey]: "model-secret",
        [requestLlmHeaderNames.headers]: JSON.stringify({
          "X-Tenant": "tenant-1",
        }),
        [requestLlmHeaderNames.temperature]: "0.7",
        [requestLlmHeaderNames.maxOutputTokens]: "8192",
      },
    } as never;

    expect(parseRequestLlmConfig(request, "optional")).toEqual({
      endpoint: "https://models.example.com/v1",
      model: "managed-model",
      apiKey: "model-secret",
      headers: { "X-Tenant": "tenant-1" },
      temperature: 0.7,
      maxOutputTokens: 8192,
    });
  });

  test("falls back when optional headers are absent and rejects missing required config", () => {
    const request = { headers: {} } as never;
    expect(parseRequestLlmConfig(request, "optional")).toBeUndefined();
    expect(() => parseRequestLlmConfig(request, "required")).toThrow(
      "requires request-scoped",
    );
  });

  test("rejects partial, invalid, and disabled overrides", () => {
    expect(() =>
      parseRequestLlmConfig(
        {
          headers: {
            [requestLlmHeaderNames.model]: "managed-model",
            [requestLlmHeaderNames.apiKey]: "model-secret",
          },
        } as never,
        "optional",
      ),
    ).toThrow("Invalid request-scoped");
    expect(() =>
      parseRequestLlmConfig(
        {
          headers: {
            [requestLlmHeaderNames.endpoint]: "https://models.example.com/v1",
            [requestLlmHeaderNames.model]: "managed-model",
            [requestLlmHeaderNames.headers]: JSON.stringify({
              Host: "evil.example.com",
            }),
          },
        } as never,
        "optional",
      ),
    ).toThrow("is not allowed");
    expect(() =>
      parseRequestLlmConfig(
        {
          headers: {
            [requestLlmHeaderNames.endpoint]: "https://models.example.com/v1",
          },
        } as never,
        "disabled",
      ),
    ).toThrow("disabled");
  });
});

describe("public demo research helpers", () => {
  test("stops waiting for unresolved research when the route is aborted", async () => {
    const controller = new AbortController();
    const pending = waitForResearchAbort(
      new Promise(() => undefined),
      controller.signal,
    );

    controller.abort(new Error("Research client lease expired"));

    await expect(pending).rejects.toThrow("Research client lease expired");
  });

  test("allows only the owning API key to cancel an active research lease", () => {
    const controller = new AbortController();
    const cleanup = registerResearchLease("task-1", "key-1", controller);

    expect(cancelResearchLease("task-1", "key-2")).toBe("forbidden");
    expect(controller.signal.aborted).toBe(false);
    expect(cancelResearchLease("task-1", "key-1")).toBe("cancelled");
    expect(controller.signal.reason).toEqual(
      new Error("Research task cancelled by client"),
    );

    cleanup();
    expect(cancelResearchLease("task-1", "key-1")).toBe("missing");
  });

  test("aborts work when the response closes even if Node marks it ended", () => {
    const socket = new EventEmitter();
    const requestRaw = new EventEmitter();
    Object.assign(requestRaw, { socket });
    const replyRaw = new EventEmitter();
    Object.assign(replyRaw, { writableEnded: true });
    const controller = createRequestAbortController(
      { raw: requestRaw } as never,
      { raw: replyRaw } as never,
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
      { raw: replyRaw } as never,
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
      { raw: replyRaw } as never,
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
      allowPrivateNetworks: false,
    });
  });

  test("clamps request limits to demo caps", () => {
    expect(
      clampDemoRequest(
        {
          query: "test",
          maxConcurrency: 8,
          maxDepth: 8,
          maxPages: 32,
          timeoutMs: 300000,
        },
        config,
      ),
    ).toEqual({
      query: "test",
      maxConcurrency: 2,
      maxDepth: 2,
      maxPages: 4,
      timeoutMs: 120000,
    });
  });

  test("renders llms.txt docs with the configured public base URL", async () => {
    const docs = await llmsTxt(config, {
      headers: {},
      ip: "127.0.0.1",
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
        url: `https://example.com/${index}`,
      })),
    });

    expect(result.truncated).toBe(true);
    expect(result.markdown).toEndWith("[Content truncated]");
    expect(result.links).toHaveLength(30);
  });
});
