import { chromium, type Browser } from "playwright";
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

function networkIdleGraceMs(timeoutMs: number) {
  return Math.min(5000, Math.max(1000, Math.floor(timeoutMs / 4)));
}

function bodyWaitMs(timeoutMs: number) {
  return Math.min(2000, Math.max(500, Math.floor(timeoutMs / 10)));
}

export class WebRenderer {
  private browserPromise: Promise<Browser> | null = null;

  constructor(private readonly headless: boolean) {}

  async render(inputUrl: string, options: { timeoutMs: number; allowPrivateNetworks: boolean }): Promise<RenderedPage> {
    const safeUrl = await assertSafeHttpUrl(inputUrl, options.allowPrivateNetworks);
    const browser = await this.browser();
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (compatible; agentic-web-research/0.1; +https://github.com/self-hosted/agentic-web-research)"
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
        waitUntil: "domcontentloaded",
        timeout: options.timeoutMs
      });
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
    if (!this.browserPromise) return;
    const browser = await this.browserPromise;
    await browser.close();
    this.browserPromise = null;
  }

  private browser() {
    this.browserPromise ??= chromium.launch({ headless: this.headless, args: ["--disable-dev-shm-usage"] });
    return this.browserPromise;
  }
}

