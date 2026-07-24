import { chromium, type Browser } from "playwright";
import { JSDOM } from "jsdom";
import { htmlToMarkdown } from "./markdown";
import { assertSafeHttpUrl, UnsafeUrlError } from "./urlSafety";

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
  signal?: AbortSignal;
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
  if (fallback instanceof UnsafeUrlError) return fallback;
  if (primary instanceof UnsafeUrlError) return primary;
  const primaryMessage = primary instanceof Error ? primary.message : String(primary);
  const fallbackMessage = fallback instanceof Error ? fallback.message : String(fallback);
  return new Error(`${primaryMessage}; fallback fetch also failed: ${fallbackMessage}`);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
  }
}

async function fetchHtmlWithSafeRedirects(
  inputUrl: string,
  options: RenderOptions
): Promise<{ response: Response; finalUrl: URL }> {
  let currentUrl = await assertSafeHttpUrl(inputUrl, options.allowPrivateNetworks);
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    throwIfAborted(options.signal);
    const response = await fetch(currentUrl, {
      signal: options.signal,
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": userAgent
      }
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: currentUrl };
    }

    const location = response.headers.get("location");
    if (!location) throw new Error(`Redirect response ${response.status} omitted Location`);
    currentUrl = await assertSafeHttpUrl(new URL(location, currentUrl).toString(), options.allowPrivateNetworks);
  }

  throw new Error("Too many redirects");
}

export class WebRenderer {
  private browserPromise: Promise<Browser> | null = null;

  constructor(private readonly headless: boolean) {}

  async render(inputUrl: string, options: RenderOptions): Promise<RenderedPage> {
    throwIfAborted(options.signal);
    const safeUrl = await assertSafeHttpUrl(inputUrl, options.allowPrivateNetworks);
    try {
      return await this.renderWithBrowser(inputUrl, safeUrl, options);
    } catch (browserError) {
      throwIfAborted(options.signal);
      try {
        return await this.renderWithFetch(inputUrl, safeUrl, options);
      } catch (fallbackError) {
        throw combineRenderErrors(browserError, fallbackError);
      }
    }
  }

  private async renderWithFetch(inputUrl: string, safeUrl: URL, options: RenderOptions): Promise<RenderedPage> {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const { response, finalUrl } = await fetchHtmlWithSafeRedirects(safeUrl.toString(), {
        ...options,
        signal: controller.signal
      });

      if (!response.ok) throw new Error(`HTTP fetch failed with ${response.status}`);
      if (!isHtmlContentType(response.headers.get("content-type"))) {
        throw new Error(`Unsupported content type: ${response.headers.get("content-type") ?? "unknown"}`);
      }

      const html = await response.text();
      const finalUrlString = response.url || finalUrl.toString();
      await assertSafeHttpUrl(finalUrlString, options.allowPrivateNetworks);
      const converted = htmlToMarkdown(html, finalUrlString);

      return {
        url: inputUrl,
        finalUrl: finalUrlString,
        title: converted.title || finalUrlString,
        markdown: converted.markdown,
        links: extractLinks(html, finalUrlString)
      };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private async renderWithBrowser(inputUrl: string, safeUrl: URL, options: RenderOptions): Promise<RenderedPage> {
    const browser = await this.browser();
    const context = await browser.newContext({
      userAgent
    });
    const abort = () => {
      void context.close().catch(() => undefined);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (blockedResourceTypes.has(request.resourceType())) {
        await route.abort();
        return;
      }
      try {
        await assertSafeHttpUrl(request.url(), options.allowPrivateNetworks);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
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
      await assertSafeHttpUrl(finalUrl, options.allowPrivateNetworks);
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
      options.signal?.removeEventListener("abort", abort);
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
      .launch({ headless: this.headless })
      .catch((error) => {
        this.browserPromise = null;
        throw error;
      });
    return this.browserPromise;
  }

  async checkAvailability() {
    const browser = await this.browser();
    return browser.isConnected();
  }
}
