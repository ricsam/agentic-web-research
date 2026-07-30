# Documentation project instructions

## About this project

- This is the Mintlify documentation for `agentic-web-research`.
- The product is a self-hosted web research API for AI agents.
- Pages are MDX files with YAML frontmatter.
- Global configuration and navigation live in `docs.json`.
- The generated endpoint reference comes from `openapi.json`.
- Product behavior must match the implementation under `apps/server`, `apps/admin`, `packages/core`, and `deploy`.

## Terminology

- Use `research task` for one request to the service.
- Use `research API key` for an `awr_...` key created in the admin console.
- Use `provider` or `model provider` for an OpenAI-compatible LLM endpoint.
- Use `admin console` for the UI at `/admin`.
- Use `Server-Sent Events` on first mention and `SSE` afterward.
- Use `SearXNG` with this capitalization.

## Style preferences

- Use active voice and second person.
- Keep sentences concise and use sentence case for headings.
- Bold UI labels, for example **Settings**.
- Format file names, commands, paths, endpoint names, and field names as code.
- Show secure production guidance alongside development examples.
- Use runnable examples and placeholder domains such as `research.example.com`.
- Never include real secrets or claim that example credentials are safe for production.

## Content boundaries

- Document public API behavior, setup, deployment, admin configuration, and operations.
- Do not expose internal admin API endpoints as supported public APIs.
- Do not promise behavior that is not implemented.
- Keep `docs/openapi.json`, `llms.txt`, and request/event types in `packages/core/src/index.ts` aligned.
