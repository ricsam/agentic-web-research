import { describe, expect, test } from "bun:test";
import { LlmConfigSchema, ResearchDefaultsSchema, ResearchRequestSchema } from "./index";

describe("core schemas", () => {
  test("applies research defaults", () => {
    expect(ResearchDefaultsSchema.parse({})).toMatchObject({
      maxConcurrency: 2,
      maxDepth: 3,
      maxPages: 8
    });
  });

  test("validates research requests", () => {
    expect(ResearchRequestSchema.parse({ query: "test" }).query).toBe("test");
    expect(() => ResearchRequestSchema.parse({ query: "" })).toThrow();
  });

  test("applies llm defaults", () => {
    expect(LlmConfigSchema.parse({}).endpoint).toBe("https://api.openai.com/v1");
  });
});

