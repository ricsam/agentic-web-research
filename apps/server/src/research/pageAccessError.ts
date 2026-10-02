function pageAccessMessage(status: number) {
  switch (status) {
    case 401:
      return "Page requires authentication (HTTP 401).";
    case 403:
      return "Page access denied (HTTP 403); the site may require authentication or block automated access.";
    case 404:
      return "Page unavailable (HTTP 404); it may be private or missing.";
    default:
      return `Page unavailable (HTTP ${status}); the target site returned an unsuccessful response.`;
  }
}

/** An HTTP failure from the target page, not from the research service. */
export class PageAccessError extends Error {
  readonly code = "PAGE_ACCESS_ERROR";

  constructor(readonly upstreamStatus: number, options?: ErrorOptions) {
    super(pageAccessMessage(upstreamStatus), options);
    this.name = "PageAccessError";
  }
}
