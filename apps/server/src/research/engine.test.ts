import { describe, expect, test } from "bun:test";
import { filterRenderedSources, readStreamPart } from "./engine";

describe("research source validation", () => {
  test("keeps only URLs that were successfully rendered", () => {
    const rendered = new Map([["https://example.com/evidence", { title: "Evidence", used: true }]]);
    expect(
      filterRenderedSources(
        [
          { url: "https://example.com/evidence#section", title: "Evidence", used: true },
          { url: "https://unrendered.example.com/", title: "Invented", used: true }
        ],
        rendered
      )
    ).toEqual([{ url: "https://example.com/evidence", title: "Evidence", used: true }]);
  });

  test("stops waiting for a stalled model stream when the request is aborted", async () => {
    const controller = new AbortController();
    const iterator: AsyncIterator<string> = {
      next: () => new Promise(() => undefined)
    };
    const pending = readStreamPart(iterator, controller.signal);

    controller.abort(new Error("Client disconnected"));

    await expect(pending).rejects.toThrow("Client disconnected");
  });
});
