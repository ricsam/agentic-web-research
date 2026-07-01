import { describe, expect, test } from "bun:test";
import {
  HeaderMapSchema,
  LlmConfigSchema,
  LlmSettingsSchema,
  OpenAiCompatibleProviderSchema,
  ResearchDefaultsSchema,
  ResearchRequestSchema
} from "./index";

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

  test("parses default LLM provider settings", () => {
    expect(LlmSettingsSchema.parse({})).toEqual({ providers: [] });
  });

  test("validates provider endpoint/model and applies defaults", () => {
    const provider = OpenAiCompatibleProviderSchema.parse({
      id: "provider-1",
      name: "OpenAI",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4.1-mini"
    });

    expect(provider.headers).toEqual({});
    expect(provider.temperature).toBe(0.2);
    expect(provider.maxOutputTokens).toBe(4096);
    expect(OpenAiCompatibleProviderSchema.parse({
      id: "provider-2",
      name: "Large context model",
      endpoint: "https://api.example.com/v1",
      model: "large-output-model",
      maxOutputTokens: 128000
    }).maxOutputTokens).toBe(128000);
  });

  test("rejects invalid provider endpoint", () => {
    expect(() =>
      OpenAiCompatibleProviderSchema.parse({
        id: "provider-1",
        name: "OpenAI",
        endpoint: "not-a-url",
        model: "gpt-4.1-mini"
      })
    ).toThrow();
  });

  test("rejects empty and duplicate header names", () => {
    expect(() => HeaderMapSchema.parse({ " ": "value" })).toThrow();
    expect(() => HeaderMapSchema.parse({ Authorization: "a", authorization: "b" })).toThrow();
  });
});

