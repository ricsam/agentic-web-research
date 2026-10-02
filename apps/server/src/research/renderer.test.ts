import { describe, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { WebRenderer } from "./renderer";
import { PageAccessError } from "./pageAccessError";
import { UnsafeUrlError } from "./urlSafety";

// Instance-local doubles keep fallback tests independent of installed Chromium.
function internals(renderer: WebRenderer) {
  return renderer as unknown as {
    browser: () => Promise<Browser>;
    renderWithBrowser: WebRenderer["render"];
    renderWithFetch: WebRenderer["render"];
  };
}

const options = { timeoutMs: 5000, allowPrivateNetworks: true };
const readableHtml = "<main><h1>Readable page</h1><p>This article contains meaningful readable content, even when served with an error status.</p></main>";

describe("WebRenderer", () => {
  test.each([401, 403, 404, 429, 500, 503])("preserves fallback HTTP %i after browser extraction fails", async (status) => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(readableHtml, { status, headers: { "content-type": "text/html" } })
    });
    const renderer = new WebRenderer(true);
    const browserError = new Error("Page did not contain meaningful readable article content after rendering");
    internals(renderer).renderWithBrowser = async () => { throw browserError; };
    try {
      const error = await renderer.render(server.url.toString(), options).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(PageAccessError);
      expect(error).toMatchObject({ code: "PAGE_ACCESS_ERROR", upstreamStatus: status });
      expect((error as Error).message).toContain(`HTTP ${status}`);
      expect((error as Error).cause).toBeInstanceOf(AggregateError);
      expect(((error as Error).cause as AggregateError).errors[0]).toBe(browserError);
    } finally {
      await renderer.close();
      await server.stop(true);
    }
  });

  test.each([403, 404])("rejects browser navigation HTTP %i before extracting a readable error page", async (status) => {
    const renderer = new WebRenderer(true);
    let extracted = false;
    let closed = false;
    const context = {
      route: async () => {},
      newPage: async () => ({
        goto: async () => ({ ok: () => false, status: () => status }),
        waitForLoadState: async () => {},
        locator: () => ({ waitFor: async () => {} }),
        url: () => "https://example.com/",
        title: async () => "Error page",
        evaluate: async () => { extracted = true; throw new Error("Must not extract error pages"); }
      }),
      close: async () => { closed = true; }
    };
    internals(renderer).browser = async () => ({ newContext: async () => context }) as unknown as Browser;
    // A generic fallback failure must not hide the browser's HTTP status.
    internals(renderer).renderWithFetch = async () => { throw new Error("fetch connection failed"); };
    const error = await renderer.render("https://example.com/", options).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PageAccessError);
    expect(error).toMatchObject({ upstreamStatus: status });
    expect(extracted).toBe(false);
    expect(closed).toBe(true);
  });

  test("prefers the fallback HTTP status when both attempts have HTTP failures", async () => {
    const renderer = new WebRenderer(true);
    internals(renderer).renderWithBrowser = async () => { throw new PageAccessError(403); };
    internals(renderer).renderWithFetch = async () => { throw new PageAccessError(404); };
    await expect(renderer.render("https://example.com/", options)).rejects.toMatchObject({
      code: "PAGE_ACCESS_ERROR", upstreamStatus: 404
    });
  });

  test.each(["browser", "fallback"])("URL-safety errors from the %s take precedence over page-access errors", async (source) => {
    const unsafeFallback = source === "fallback";
    const renderer = new WebRenderer(true);
    const unsafeError = new UnsafeUrlError("Private network URLs are disabled");
    internals(renderer).renderWithBrowser = async () => { throw unsafeFallback ? new PageAccessError(403) : unsafeError; };
    internals(renderer).renderWithFetch = async () => { throw unsafeFallback ? unsafeError : new PageAccessError(404); };
    await expect(renderer.render("https://example.com/", options)).rejects.toBe(unsafeError);
  });

  test("keeps unexpected failures unclassified", async () => {
    const renderer = new WebRenderer(true);
    internals(renderer).renderWithBrowser = async () => { throw new Error("browser failure"); };
    internals(renderer).renderWithFetch = async () => { throw new Error("fetch failure"); };
    const error = await renderer.render("https://example.com/", options).catch((error: unknown) => error);
    expect(error).not.toBeInstanceOf(PageAccessError);
    expect((error as Error).message).toBe("browser failure; fallback fetch also failed: fetch failure");
  });

  test("preserves the final upstream HTTP status after a redirect", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => new URL(request.url).pathname === "/"
        ? new Response(null, { status: 302, headers: { location: "/missing" } })
        : new Response("Not found", { status: 404 })
    });
    const renderer = new WebRenderer(true);
    internals(renderer).renderWithBrowser = async () => { throw new Error("browser failure"); };
    try {
      await expect(renderer.render(server.url.toString(), options)).rejects.toMatchObject({
        code: "PAGE_ACCESS_ERROR", upstreamStatus: 404
      });
    } finally {
      await renderer.close();
      await server.stop(true);
    }
  });

  test("allows a successful fallback after a browser HTTP failure", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(readableHtml, { headers: { "content-type": "text/html" } })
    });
    const renderer = new WebRenderer(true);
    internals(renderer).renderWithBrowser = async () => { throw new PageAccessError(403); };
    try {
      const result = await renderer.render(server.url.toString(), options);
      expect(result.title).toBe("Readable page");
      expect(result.markdown).toContain("meaningful readable content");
    } finally {
      await renderer.close();
      await server.stop(true);
    }
  });

  test("falls back to plain HTML fetch when Chromium cannot render a page", async () => {
    const html = `<!doctype html>
      <html>
        <head><title>Fallback document</title></head>
        <body>
          <main>
            <h1>Fallback document</h1>
            <p>This page was fetched without a browser.</p>
            <a href="/next">Next page</a>
          </main>
        </body>
      </html>`;
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
    });

    try {
      const renderer = new WebRenderer(true);
      // Exercise the production fallback path without depending on local Chromium libraries.
      (renderer as unknown as { renderWithBrowser: () => Promise<never> }).renderWithBrowser = async () => {
        throw new Error("forced browser failure");
      };

      const result = await renderer.render(server.url.toString(), {
        timeoutMs: 5000,
        allowPrivateNetworks: true
      });

      expect(result.title).toBe("Fallback document");
      expect(result.markdown).toContain("This page was fetched without a browser.");
      expect(result.links).toContainEqual({ title: "Next page", url: new URL("/next", server.url).toString() });
      await renderer.close();
    } finally {
      await server.stop();
    }
  });
});
