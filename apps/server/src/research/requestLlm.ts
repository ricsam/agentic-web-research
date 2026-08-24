import {
  RequestLlmConfigSchema,
  type RequestLlmConfig,
} from "@agentic-web-research/core";
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../config";

export const requestLlmHeaderNames = {
  endpoint: "x-awr-llm-endpoint",
  model: "x-awr-llm-model",
  apiKey: "x-awr-llm-api-key",
  headers: "x-awr-llm-headers",
  temperature: "x-awr-llm-temperature",
  maxOutputTokens: "x-awr-llm-max-output-tokens",
} as const;

const requestLlmHeaders = Object.values(requestLlmHeaderNames);
const MAX_CUSTOM_HEADERS_JSON_LENGTH = 32_768;
const FORBIDDEN_CUSTOM_HEADER_NAMES = new Set([
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export class RequestLlmConfigError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "RequestLlmConfigError";
  }
}

function readSingleHeader(request: FastifyRequest, name: string) {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    throw new RequestLlmConfigError(`${name} must be sent exactly once`);
  }
  return value;
}

function parseCustomHeaders(raw: string | undefined) {
  if (!raw) return {};
  if (raw.length > MAX_CUSTOM_HEADERS_JSON_LENGTH) {
    throw new RequestLlmConfigError(
      `${requestLlmHeaderNames.headers} is too large`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RequestLlmConfigError(
      `${requestLlmHeaderNames.headers} must be a JSON object with string values`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestLlmConfigError(
      `${requestLlmHeaderNames.headers} must be a JSON object with string values`,
    );
  }

  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    const normalized = name.trim().toLowerCase();
    if (
      !HEADER_NAME_PATTERN.test(name) ||
      FORBIDDEN_CUSTOM_HEADER_NAMES.has(normalized)
    ) {
      throw new RequestLlmConfigError(
        `Custom LLM header ${JSON.stringify(name)} is not allowed`,
      );
    }
    if (typeof headerValue !== "string" || /[\r\n]/.test(headerValue)) {
      throw new RequestLlmConfigError(
        `Custom LLM header ${JSON.stringify(name)} must have a valid string value`,
      );
    }
    headers[name] = headerValue;
  }
  return headers;
}

function parseNumberHeader(raw: string | undefined, name: string) {
  if (raw === undefined) return undefined;
  if (!raw.trim()) throw new RequestLlmConfigError(`${name} must be a number`);
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new RequestLlmConfigError(`${name} must be a number`);
  return value;
}

export function parseRequestLlmConfig(
  request: FastifyRequest,
  mode: AppConfig["REQUEST_LLM_CONFIG_MODE"],
): RequestLlmConfig | undefined {
  const present = requestLlmHeaders.filter(
    (name) => request.headers[name] !== undefined,
  );

  if (mode === "disabled") {
    if (present.length) {
      throw new RequestLlmConfigError(
        "Request-scoped LLM configuration is disabled",
        403,
      );
    }
    return undefined;
  }
  if (!present.length) {
    if (mode === "required") {
      throw new RequestLlmConfigError(
        "This deployment requires request-scoped LLM configuration",
      );
    }
    return undefined;
  }

  const endpoint = readSingleHeader(request, requestLlmHeaderNames.endpoint);
  const model = readSingleHeader(request, requestLlmHeaderNames.model);
  const apiKey = readSingleHeader(request, requestLlmHeaderNames.apiKey);
  const customHeaders = readSingleHeader(
    request,
    requestLlmHeaderNames.headers,
  );
  const temperature = readSingleHeader(
    request,
    requestLlmHeaderNames.temperature,
  );
  const maxOutputTokens = readSingleHeader(
    request,
    requestLlmHeaderNames.maxOutputTokens,
  );

  const result = RequestLlmConfigSchema.safeParse({
    endpoint,
    model,
    apiKey,
    headers: parseCustomHeaders(customHeaders),
    temperature: parseNumberHeader(
      temperature,
      requestLlmHeaderNames.temperature,
    ),
    maxOutputTokens: parseNumberHeader(
      maxOutputTokens,
      requestLlmHeaderNames.maxOutputTokens,
    ),
  });
  if (!result.success) {
    throw new RequestLlmConfigError(
      `Invalid request-scoped LLM configuration: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return result.data;
}
