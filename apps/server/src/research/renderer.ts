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
    const page = await context.newPage();

    try {
      await page.goto(safeUrl.toString(), {
        waitUntil: "networkidle",
        timeout: options.timeoutMs
      });
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
    this.browserPromise ??= chromium.launch({ headless: this.headless });
    return this.browserPromise;
  }
}

