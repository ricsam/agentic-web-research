import { chromium, type Browser, type Page } from "playwright";
import {
  htmlToMarkdown,
  isReadableContent,
  type ContentMetrics
} from "./markdown";
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
const MAX_BROWSER_LAUNCH_TIMEOUT_MS = 15_000;

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

type BrowserContentSnapshot = {
  html: string;
  title: string;
  metrics: ContentMetrics;
};

async function extractBrowserContent(page: Page): Promise<BrowserContentSnapshot> {
  const snapshot = await page.evaluate(() => {
    const rootSelector = [
      "article",
      "main",
      '[role="main"]',
      "#main-content",
      "#content",
      ".main-content",
      ".article-content",
      ".docs-content",
      "[data-pagefind-body]"
    ].join(",");
    const noiseSelector = [
      "nav",
      "aside",
      "footer",
      "script",
      "style",
      "template",
      "noscript",
      "svg",
      "canvas",
      "form",
      "button",
      "dialog",
      '[role="navigation"]',
      '[role="banner"]',
      '[role="complementary"]',
      '[role="menu"]',
      '[role="menuitem"]',
      "[hidden]",
      '[aria-hidden="true"]',
      '[aria-label*="breadcrumb" i]',
      '[class*="sidebar" i]',
      '[id*="sidebar" i]',
      '[class*="breadcrumb" i]',
      '[id*="breadcrumb" i]',
      '[class*="table-of-contents" i]',
      '[id*="table-of-contents" i]',
      '[class*="dropdown" i]',
      '[class~="toc"]',
      "#toc"
    ].join(",");
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const metricsFor = (element: Element) => {
      const textLength = normalize(element.textContent).length;
      const linkTextLength = Array.from(element.querySelectorAll("a"))
        .reduce((total, link) => total + normalize(link.textContent).length, 0);
      return {
        textLength,
        linkTextLength,
        paragraphCount: element.querySelectorAll("p").length,
        headingCount: element.querySelectorAll("h1, h2, h3, h4, h5, h6").length,
        preformattedCount: element.querySelectorAll("pre").length,
        tableCount: element.querySelectorAll("table").length,
        blockquoteCount: element.querySelectorAll("blockquote").length,
        listItemCount: element.querySelectorAll("li").length
      };
    };
    const score = (metrics: ContentMetrics) => {
      const nonLinkTextLength = Math.max(0, metrics.textLength - metrics.linkTextLength);
      return (
        nonLinkTextLength +
        metrics.paragraphCount * 120 +
        metrics.headingCount * 80 +
        metrics.preformattedCount * 160 +
        metrics.tableCount * 200 +
        metrics.blockquoteCount * 80 -
        metrics.linkTextLength * 0.75 -
        Math.max(0, metrics.listItemCount - 20) * 8
      );
    };
    const prepare = (element: Element) => {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return null;
      const clone = element.cloneNode(true) as Element;
      clone.querySelectorAll(noiseSelector).forEach((node) => node.remove());
      const metrics = metricsFor(clone);
      return {
        html: clone.outerHTML,
        title: normalize(clone.querySelector("h1")?.textContent) || document.title || location.href,
        metrics,
        score: score(metrics)
      };
    };

    const roots = Array.from(new Set(document.querySelectorAll(rootSelector)));
    const semanticCandidates = roots
      .map(prepare)
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate?.metrics.textLength));
    const bodyCandidate = document.body ? prepare(document.body) : null;
    const candidates = semanticCandidates.length
      ? semanticCandidates
      : bodyCandidate
        ? [bodyCandidate]
        : [];
    return candidates.sort((a, b) => b.score - a.score)[0] ?? null;
  });

  if (!snapshot || !isReadableContent(snapshot.metrics)) {
    throw new Error("Page did not contain meaningful readable article content after rendering");
  }
  return snapshot;
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
        links: converted.links
      };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private async renderWithBrowser(inputUrl: string, safeUrl: URL, options: RenderOptions): Promise<RenderedPage> {
    const browser = await this.browser(Math.min(options.timeoutMs, MAX_BROWSER_LAUNCH_TIMEOUT_MS));
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
      const finalUrl = page.url();
      await assertSafeHttpUrl(finalUrl, options.allowPrivateNetworks);
      const fallbackTitle = await page.title();
      const snapshot = await extractBrowserContent(page);
      const converted = htmlToMarkdown(snapshot.html, finalUrl, snapshot.title || fallbackTitle);

      return {
        url: inputUrl,
        finalUrl,
        title: converted.title || fallbackTitle || finalUrl,
        markdown: converted.markdown,
        links: converted.links
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
    const browser = await browserPromise.catch(() => null);
    if (browser?.isConnected()) {
      await browser.close({ reason: "WebRenderer closed" });
    }
  }

  private browser(timeoutMs = MAX_BROWSER_LAUNCH_TIMEOUT_MS): Promise<Browser> {
    const currentPromise = this.browserPromise;
    if (currentPromise) {
      return currentPromise.then((browser) => {
        if (browser.isConnected()) return browser;
        if (this.browserPromise === currentPromise) {
          this.browserPromise = null;
        }
        return this.browser(timeoutMs);
      });
    }

    const launchPromise = chromium.launch({
      headless: this.headless,
      timeout: timeoutMs
    });
    this.browserPromise = launchPromise;
    void launchPromise.then(
      (browser) => {
        browser.once("disconnected", () => {
          if (this.browserPromise === launchPromise) {
            this.browserPromise = null;
          }
        });
      },
      () => {
        if (this.browserPromise === launchPromise) {
          this.browserPromise = null;
        }
      }
    );
    return launchPromise;
  }
}
