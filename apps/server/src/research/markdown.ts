import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-"
});

const maxSourceHtmlChars = 2_000_000;

const contentRootSelector = [
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
  '#toc'
].join(",");

export type ContentMetrics = {
  textLength: number;
  linkTextLength: number;
  paragraphCount: number;
  headingCount: number;
  preformattedCount: number;
  tableCount: number;
  blockquoteCount: number;
  listItemCount: number;
};

type ExtractionCandidate = {
  element: Element;
  method: "readability" | "semantic" | "body";
  title?: string;
  metrics: ContentMetrics;
  score: number;
};

function normalizeText(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function contentMetrics(element: Element): ContentMetrics {
  const textLength = normalizeText(element.textContent).length;
  const linkTextLength = Array.from(element.querySelectorAll("a"))
    .reduce((total, link) => total + normalizeText(link.textContent).length, 0);

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
}

export function readableContentScore(metrics: ContentMetrics) {
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
}

export function isReadableContent(metrics: ContentMetrics) {
  const nonLinkTextLength = Math.max(0, metrics.textLength - metrics.linkTextLength);
  const linkDensity = metrics.linkTextLength / Math.max(metrics.textLength, 1);
  const proseBlocks =
    metrics.paragraphCount +
    metrics.preformattedCount +
    metrics.tableCount +
    metrics.blockquoteCount;
  const contentBlocks = proseBlocks + metrics.headingCount;

  if (metrics.textLength < 40 || nonLinkTextLength < 24) return false;
  if (contentBlocks === 0 && nonLinkTextLength < 160) return false;
  if (linkDensity > 0.65 && proseBlocks < 2) return false;
  if (metrics.listItemCount > 20 && proseBlocks === 0) return false;
  return true;
}

function cleanClone(element: Element) {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll(noiseSelector).forEach((node) => node.remove());
  return clone;
}

function candidateFromElement(
  element: Element,
  method: ExtractionCandidate["method"],
  title?: string
): ExtractionCandidate {
  const cleaned = cleanClone(element);
  const metrics = contentMetrics(cleaned);
  return {
    element: cleaned,
    method,
    title: normalizeText(cleaned.querySelector("h1")?.textContent) || title,
    metrics,
    score: readableContentScore(metrics)
  };
}

function readabilityCandidate(document: Document) {
  const readabilityDocument = document.cloneNode(true) as Document;
  const article = new Readability(readabilityDocument).parse();
  if (!article?.content) return null;

  const container = document.createElement("article");
  container.innerHTML = article.content;
  return candidateFromElement(container, "readability", article.title ?? undefined);
}

function selectCandidate(document: Document) {
  const candidates: ExtractionCandidate[] = [];
  const readability = readabilityCandidate(document);
  if (readability) candidates.push(readability);

  const seen = new Set<Element>();
  for (const element of Array.from(document.querySelectorAll(contentRootSelector))) {
    if (seen.has(element)) continue;
    seen.add(element);
    candidates.push(candidateFromElement(element, "semantic"));
  }

  if (document.body) {
    candidates.push(candidateFromElement(document.body, "body"));
  }

  const acceptable = candidates.filter((candidate) => isReadableContent(candidate.metrics));
  const semantic = acceptable
    .filter((candidate) => candidate.method === "semantic")
    .sort((a, b) => b.score - a.score);
  if (semantic[0]) return semantic[0];

  const readabilityResult = acceptable.find((candidate) => candidate.method === "readability");
  if (readabilityResult) return readabilityResult;
  return acceptable.find((candidate) => candidate.method === "body");
}

function resolveUrl(rawValue: string | null, baseUrl: string, allowedProtocols: ReadonlySet<string>) {
  const value = rawValue?.trim();
  if (!value) return null;

  try {
    const resolved = new URL(value, baseUrl);
    return allowedProtocols.has(resolved.protocol) ? resolved.toString() : null;
  } catch {
    return null;
  }
}

const linkProtocols = new Set(["http:", "https:", "mailto:", "tel:"]);
const imageProtocols = new Set(["http:", "https:"]);

function normalizeContentUrls(element: Element, fallbackBaseUrl: string) {
  const baseUrl = element.ownerDocument.baseURI || fallbackBaseUrl;

  for (const anchor of Array.from(element.querySelectorAll("a[href]"))) {
    const resolved = resolveUrl(anchor.getAttribute("href"), baseUrl, linkProtocols);
    if (resolved) {
      anchor.setAttribute("href", resolved);
    } else {
      anchor.removeAttribute("href");
    }
  }

  for (const image of Array.from(element.querySelectorAll("img"))) {
    const resolved = resolveUrl(image.getAttribute("src"), baseUrl, imageProtocols);
    if (!resolved) {
      image.remove();
      continue;
    }

    const labelText = normalizeText(image.getAttribute("alt") || image.getAttribute("title"));
    const label = `Image: ${labelText || "Image"}`;
    const enclosingAnchor = image.closest("a");
    if (enclosingAnchor && element.contains(enclosingAnchor)) {
      const labelElement = element.ownerDocument.createElement("span");
      labelElement.textContent = label;
      image.replaceWith(labelElement);
      continue;
    }

    const link = element.ownerDocument.createElement("a");
    link.setAttribute("href", resolved);
    link.textContent = label;
    image.replaceWith(link);
  }
}

function extractLinks(element: Element) {
  const seen = new Set<string>();
  return Array.from(element.querySelectorAll("a[href]"))
    .map((anchor) => {
      const link = anchor as HTMLAnchorElement;
      return {
        title: normalizeText(link.textContent || link.title || link.href).slice(0, 160),
        url: link.href
      };
    })
    .filter((link) => {
      if (!link.url || seen.has(link.url)) return false;
      seen.add(link.url);
      return link.url.startsWith("http://") || link.url.startsWith("https://");
    })
    .slice(0, 50);
}

export function htmlToMarkdown(html: string, url: string, fallbackTitle?: string) {
  if (html.length > maxSourceHtmlChars) {
    throw new Error(`HTML document is too large to extract safely (${html.length} characters)`);
  }

  const dom = new JSDOM(html, { url });
  try {
    const document = dom.window.document;
    const selected = selectCandidate(document);
    if (!selected) {
      throw new Error("Page did not contain meaningful readable article content");
    }

    normalizeContentUrls(selected.element, url);
    const markdown = turndown
      .turndown(selected.element.innerHTML)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!markdown) {
      throw new Error("Readable article content produced empty Markdown");
    }

    return {
      title: selected.title || document.title || fallbackTitle || url,
      markdown,
      links: extractLinks(selected.element)
    };
  } finally {
    dom.window.close();
  }
}
