import { describe, expect, test } from "bun:test";
import { filterRenderedSources } from "./engine";

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
});
