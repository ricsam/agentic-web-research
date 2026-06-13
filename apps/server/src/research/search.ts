import type { SearchResult } from "@agentic-web-research/core";

type SearxngResult = {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  score?: number;
};

export async function searchWeb(searxngUrl: string, query: string): Promise<SearchResult[]> {
  const url = new URL("/search", searxngUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", "general");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "agentic-web-research/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`SearXNG search failed with ${response.status}`);
  }

  const body = (await response.json()) as { results?: SearxngResult[] };
  return (body.results ?? [])
    .filter((result): result is Required<Pick<SearxngResult, "title" | "url">> & SearxngResult => {
      return typeof result.title === "string" && typeof result.url === "string";
    })
    .slice(0, 10)
    .map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.content,
      engine: result.engine,
      score: result.score
    }));
}

