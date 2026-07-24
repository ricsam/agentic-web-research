import { describe, expect, test } from "bun:test";
import { htmlToMarkdown } from "./markdown";

function cloudflareStyleDocument(
  articleText: string,
  articlePath: string,
  navigationItems = 4_000
) {
  const navigation = Array.from(
    { length: navigationItems },
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
      cloudflareStyleDocument("First endpoint details.", "/first", 100),
      "https://developers.example.com/api/first"
    );
    const second = htmlToMarkdown(
      cloudflareStyleDocument("Second endpoint details.", "/second", 100),
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

  test("resolves article links against the final page URL", () => {
    const result = htmlToMarkdown(
      `<html>
        <head><title>URL resolution</title></head>
        <body>
          <main>
            <h1>URL resolution</h1>
            <p>Documentation with enough meaningful prose for extraction.</p>
            <a href="/root">Root relative</a>
            <a href="next?tab=one#example">Path relative</a>
            <a href="//cdn.example.net/reference">Protocol relative</a>
            <a href="#section">Section</a>
            <a href="https://other.example.net/absolute">Absolute</a>
            <a href="mailto:docs@example.com">Email</a>
            <a href="tel:+4612345678">Telephone</a>
          </main>
        </body>
      </html>`,
      "https://docs.example.com/guides/current/page"
    );

    expect(result.markdown).toContain("[Root relative](https://docs.example.com/root)");
    expect(result.markdown).toContain(
      "[Path relative](https://docs.example.com/guides/current/next?tab=one#example)"
    );
    expect(result.markdown).toContain("[Protocol relative](https://cdn.example.net/reference)");
    expect(result.markdown).toContain(
      "[Section](https://docs.example.com/guides/current/page#section)"
    );
    expect(result.markdown).toContain("[Absolute](https://other.example.net/absolute)");
    expect(result.markdown).toContain("[Email](mailto:docs@example.com)");
    expect(result.markdown).toContain("[Telephone](tel:+4612345678)");
  });

  test("respects the document base URL when resolving links and images", () => {
    const result = htmlToMarkdown(
      `<html>
        <head>
          <title>Base URL</title>
          <base href="/api/assets/">
        </head>
        <body>
          <main>
            <h1>Base URL</h1>
            <p>Documentation with an asset and a related page.</p>
            <a href="reference">Reference</a>
            <img src="logo.svg?version=1#mark" alt="Documentation logo">
          </main>
        </body>
      </html>`,
      "https://developers.example.com/api/page"
    );

    expect(result.markdown).toContain(
      "[Reference](https://developers.example.com/api/assets/reference)"
    );
    expect(result.markdown).toContain(
      "[Image: Documentation logo](https://developers.example.com/api/assets/logo.svg?version=1#mark)"
    );
    expect(result.markdown).not.toContain("![");
    expect(result.links).toContainEqual({
      title: "Image: Documentation logo",
      url: "https://developers.example.com/api/assets/logo.svg?version=1#mark"
    });
  });

  test("removes unsafe links and image sources", () => {
    const result = htmlToMarkdown(
      `<html>
        <head><title>Unsafe URLs</title></head>
        <body>
          <main>
            <h1>Unsafe URLs</h1>
            <p>Untrusted content must not create executable or local resource links.</p>
            <a href="javascript:alert(1)">Unsafe JavaScript</a>
            <a href="file:///etc/passwd">Unsafe file</a>
            <img src="data:image/svg+xml,unsafe" alt="Embedded data">
            <img src="blob:https://example.com/identifier" alt="Blob data">
          </main>
        </body>
      </html>`,
      "https://example.com/article"
    );

    expect(result.markdown).toContain("Unsafe JavaScript");
    expect(result.markdown).toContain("Unsafe file");
    expect(result.markdown).not.toContain("javascript:");
    expect(result.markdown).not.toContain("file:");
    expect(result.markdown).not.toContain("data:");
    expect(result.markdown).not.toContain("blob:");
    expect(result.markdown).not.toContain("Embedded data");
    expect(result.markdown).not.toContain("Blob data");
  });

  test("preserves the destination of an image that is already linked", () => {
    const result = htmlToMarkdown(
      `<html>
        <head><title>Linked image</title></head>
        <body>
          <main>
            <h1>Linked image</h1>
            <p>The image opens a higher-level diagram page.</p>
            <a href="/diagram"><img src="/diagram.svg" alt="Architecture diagram"></a>
          </main>
        </body>
      </html>`,
      "https://example.com/docs/page"
    );

    expect(result.markdown).toContain(
      "[Image: Architecture diagram](https://example.com/diagram)"
    );
    expect(result.markdown).not.toContain("diagram.svg");
    expect(result.markdown).not.toContain("![");
  });
});
