import { chromium, type Browser } from "playwright";
import { JSDOM } from "jsdom";
import { htmlToMarkdown } from "./markdown";
import { assertSafeHttpUrl } from "./urlSafety";

export type RenderedPage = {
  url: string;
  finalUrl: string;
  title: string;
  markdown: string;
  links: Array<{ title: string; url: string }>;
};

const blockedResourceTypes = new Set(["font", "image", "media"]);
const userAgent = "Mozilla/5.0 (compatible; agentic-web-research/0.1; +https://github.com/self-hosted/agentic-web-research)";

type RenderOptions = {
  timeoutMs: number;
  allowPrivateNetworks: boolean;
};

function networkIdleGraceMs(timeoutMs: number) {
  return Math.min(5000, Math.max(1000, Math.floor(timeoutMs / 4)));
}

function bodyWaitMs(timeoutMs: number) {
  return Math.min(2000, Math.max(500, Math.floor(timeoutMs / 10)));
}

function isHtmlContentType(contentType: string | null) {
  if (!contentType) return true;
  return contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
}

function extractLinks(html: string, finalUrl: string) {
  const dom = new JSDOM(html, { url: finalUrl });
  const seen = new Set<string>();
  try {
    return Array.from(dom.window.document.querySelectorAll("a[href]"))
      .map((anchor) => {
        const element = anchor as HTMLAnchorElement;
        return {
          title: (element.textContent || element.title || element.href).trim().slice(0, 160),
          url: element.href
        };
      })
      .filter((link) => {
        if (!link.url || seen.has(link.url)) return false;
        seen.add(link.url);
        return link.url.startsWith("http://") || link.url.startsWith("https://");
      })
      .slice(0, 50);
  } finally {
    dom.window.close();
  }
}

function combineRenderErrors(primary: unknown, fallback: unknown) {
  const primaryMessage = primary instanceof Error ? primary.message : String(primary);
  const fallbackMessage = fallback instanceof Error ? fallback.message : String(fallback);
  return new Error(`${primaryMessage}; fallback fetch also failed: ${fallbackMessage}`);
}

export class WebRenderer {
  private browserPromise: Promise<Browser> | null = null;

  constructor(private readonly headless: boolean) {}

  async render(inputUrl: string, options: RenderOptions): Promise<RenderedPage> {
    const safeUrl = await assertSafeHttpUrl(inputUrl, options.allowPrivateNetworks);
    try {
      return await this.renderWithBrowser(inputUrl, safeUrl, options);
    } catch (browserError) {
      try {
        return await this.renderWithFetch(inputUrl, safeUrl, options);
      } catch (fallbackError) {
        throw combineRenderErrors(browserError, fallbackError);
      }
    }
  }

  private async renderWithFetch(inputUrl: string, safeUrl: URL, options: RenderOptions): Promise<RenderedPage> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(safeUrl, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": userAgent
        }
      });

      if (!response.ok) throw new Error(`HTTP fetch failed with ${response.status}`);
      if (!isHtmlContentType(response.headers.get("content-type"))) {
        throw new Error(`Unsupported content type: ${response.headers.get("content-type") ?? "unknown"}`);
      }

      const html = await response.text();
      const finalUrl = response.url || safeUrl.toString();
      const converted = htmlToMarkdown(html, finalUrl);

      return {
        url: inputUrl,
        finalUrl,
        title: converted.title || finalUrl,
        markdown: converted.markdown,
        links: extractLinks(html, finalUrl)
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async renderWithBrowser(inputUrl: string, safeUrl: URL, options: RenderOptions): Promise<RenderedPage> {
    const browser = await this.browser();
    const context = await browser.newContext({
      userAgent
    });
    await context.route("**/*", async (route) => {
      if (blockedResourceTypes.has(route.request().resourceType())) {
        await route.abort();
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();

    try {
      await page.goto(safeUrl.toString(), {
        waitUntil: "commit",
        timeout: options.timeoutMs
      });
      await page.waitForLoadState("domcontentloaded", { timeout: bodyWaitMs(options.timeoutMs) }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: networkIdleGraceMs(options.timeoutMs) }).catch(() => undefined);
      await page.locator("body").waitFor({ state: "attached", timeout: bodyWaitMs(options.timeoutMs) }).catch(() => undefined);
      const html = await page.content();
      const finalUrl = page.url();
      const fallbackTitle = await page.title();
      const links = await page.$$eval("a[href]", (anchors) => {
        const seen = new Set<string>();
        return anchors
          .map((anchor) => {
            const element = anchor as HTMLAnchorElement;
            return {
              title: (element.innerText || element.title || element.href).trim().slice(0, 160),
              url: element.href
            };
          })
          .filter((link) => {
            if (!link.url || seen.has(link.url)) return false;
            seen.add(link.url);
            return link.url.startsWith("http://") || link.url.startsWith("https://");
          })
          .slice(0, 50);
      });
      const converted = htmlToMarkdown(html, finalUrl);

      return {
        url: inputUrl,
        finalUrl,
        title: converted.title || fallbackTitle || finalUrl,
        markdown: converted.markdown,
        links
      };
    } finally {
      await context.close();
    }
  }

  async close() {
    const browserPromise = this.browserPromise;
    this.browserPromise = null;
    if (!browserPromise) return;
    const browser = await browserPromise;
    await browser.close({ reason: "WebRenderer closed" });
  }

  private browser() {
    this.browserPromise ??= chromium
      .launch({ headless: this.headless, args: ["--disable-dev-shm-usage"] })
      .catch((error) => {
        this.browserPromise = null;
        throw error;
      });
    return this.browserPromise;
  }
}

