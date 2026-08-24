import { describe, expect, test } from "bun:test";
import {
  filterRenderedSources,
  readStreamPart,
  resolveLlmProvider,
} from "./engine";
import type { Database } from "../db/database";

describe("research LLM provider resolution", () => {
  test("uses an ephemeral request override without reading the database provider", async () => {
    let databaseReads = 0;
    const db = {
      getActiveLlmProvider: async () => {
        databaseReads += 1;
        return null;
      },
    } as unknown as Database;
    const override = {
      endpoint: "https://models.example.com/v1",
      model: "caller-model",
      apiKey: "caller-secret",
      headers: {},
      temperature: 0.3,
      maxOutputTokens: 2048,
    };

    await expect(resolveLlmProvider(db, override)).resolves.toEqual({
      provider: override,
      source: "request",
    });
    expect(databaseReads).toBe(0);
  });

  test("falls back to the active database provider", async () => {
    const provider = {
      id: "provider-1",
      name: "Default",
      endpoint: "https://models.example.com/v1",
      model: "default-model",
      apiKey: "default-secret",
      headers: {},
      temperature: 0.2,
      maxOutputTokens: 4096,
    };
    const db = {
      getActiveLlmProvider: async () => provider,
    } as unknown as Database;

    await expect(resolveLlmProvider(db)).resolves.toEqual({
      provider,
      source: "database",
    });
  });
});

describe("research source validation", () => {
  test("keeps only URLs that were successfully rendered", () => {
    const rendered = new Map([
      ["https://example.com/evidence", { title: "Evidence", used: true }],
    ]);
    expect(
      filterRenderedSources(
        [
          {
            url: "https://example.com/evidence#section",
            title: "Evidence",
            used: true,
          },
          {
            url: "https://unrendered.example.com/",
            title: "Invented",
            used: true,
          },
        ],
        rendered,
      ),
    ).toEqual([
      { url: "https://example.com/evidence", title: "Evidence", used: true },
    ]);
  });

  test("stops waiting for a stalled model stream when the request is aborted", async () => {
    const controller = new AbortController();
    const iterator: AsyncIterator<string> = {
      next: () => new Promise(() => undefined),
    };
    const pending = readStreamPart(iterator, controller.signal);

    controller.abort(new Error("Client disconnected"));

    await expect(pending).rejects.toThrow("Client disconnected");
  });
});
