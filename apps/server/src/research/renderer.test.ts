import { describe, expect, test } from "bun:test";
import { WebRenderer } from "./renderer";

describe("WebRenderer", () => {
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
