import { describe, expect, test } from "bun:test";
import { htmlToMarkdown } from "./markdown";

function cloudflareStyleDocument(articleText: string, articlePath: string) {
  const navigation = Array.from(
    { length: 6_000 },
    (_, index) => `<li><a href="/api/navigation/${index}">Navigation item ${index}</a></li>`
  ).join("");

  return `<!doctype html>
    <html>
      <head><title>Cloud API reference</title></head>
      <body>
        <aside class="sidebar"><ul>${navigation}</ul></aside>
        <main>
          <button>Copy Markdown</button>
          <h1>Create a sending subdomain</h1>
          <p>${articleText}</p>
          <pre><code>POST ${articlePath}</code></pre>
          <a href="/api/authentication">Authentication requirements</a>
        </main>
      </body>
    </html>`;
}

describe("htmlToMarkdown", () => {
  test("extracts semantic article content after an oversized navigation tree", () => {
    const html = cloudflareStyleDocument(
      "This endpoint creates and verifies a customer sending subdomain.",
      "/accounts/{account_id}/email/sending/subdomains"
    );
    expect(html.length).toBeGreaterThan(250_000);

    const result = htmlToMarkdown(html, "https://developers.example.com/api/sending");

    expect(result.markdown).toContain("# Create a sending subdomain");
    expect(result.markdown).toContain("creates and verifies a customer sending subdomain");
    expect(result.markdown).toContain("POST /accounts/{account_id}/email/sending/subdomains");
    expect(result.markdown).not.toContain("Navigation item");
    expect(result.markdown).not.toContain("Copy Markdown");
    expect(result.links).toEqual([
      {
        title: "Authentication requirements",
        url: "https://developers.example.com/api/authentication"
      }
    ]);
  });

  test("does not collapse different articles with identical navigation into the same Markdown", () => {
    const first = htmlToMarkdown(
      cloudflareStyleDocument("First endpoint details.", "/first"),
      "https://developers.example.com/api/first"
    );
    const second = htmlToMarkdown(
      cloudflareStyleDocument("Second endpoint details.", "/second"),
      "https://developers.example.com/api/second"
    );

    expect(first.markdown).not.toBe(second.markdown);
    expect(first.markdown).toContain("First endpoint details");
    expect(second.markdown).toContain("Second endpoint details");
  });

  test("rejects navigation-only pages instead of reporting a successful read", () => {
    const navigation = Array.from(
      { length: 100 },
      (_, index) => `<li><a href="/page/${index}">Navigation item ${index}</a></li>`
    ).join("");

    expect(() =>
      htmlToMarkdown(
        `<html><head><title>Navigation</title></head><body><nav><ul>${navigation}</ul></nav></body></html>`,
        "https://example.com/"
      )
    ).toThrow("meaningful readable article content");
  });
});
