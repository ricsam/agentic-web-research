import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-"
});

const maxHtmlCharsForExtraction = 250000;

function trimHtmlForExtraction(html: string) {
  if (html.length <= maxHtmlCharsForExtraction) return html;
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd >= 0 ? html.slice(0, headEnd + 7) : html.slice(0, 10000);
  const bodyStart = html.search(/<body[^>]*>/i);
  const body = html.slice(bodyStart >= 0 ? bodyStart : 0, maxHtmlCharsForExtraction);
  return `${head}\n${body}\n</body></html>`;
}

export function htmlToMarkdown(html: string, url: string) {
  // Keep pathological HTML/JS payloads from spending most of a demo run in
  // server-side DOM extraction. The agent only receives a trimmed excerpt later.
  const trimmedHtml = trimHtmlForExtraction(html);
  const dom = new JSDOM(trimmedHtml, { url });
  const document = dom.window.document;
  const article = new Readability(document).parse();
  const title = article?.title || document.title || url;
  const contentHtml = article?.content || document.body?.innerHTML || html;
  const markdown = turndown.turndown(contentHtml).replace(/\n{3,}/g, "\n\n").trim();
  dom.window.close();
  return { title, markdown };
}

