import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-"
});

export function htmlToMarkdown(html: string, url: string) {
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;
  const article = new Readability(document).parse();
  const title = article?.title || document.title || url;
  const contentHtml = article?.content || document.body?.innerHTML || html;
  const markdown = turndown.turndown(contentHtml).replace(/\n{3,}/g, "\n\n").trim();
  return { title, markdown };
}

