# agentic-web-research

Self-hosted web research service for AI agents. It exposes an authenticated REST API that streams research progress, bundles SearXNG for search, renders pages with Playwright, converts pages to Markdown, and uses the Vercel AI SDK with an OpenAI-compatible endpoint to decide what to inspect next.

## Quick Start

```bash
bun install
cp .env.example .env
docker compose -f deploy/compose/docker-compose.yml up -d postgres searxng
bun run dev
```

The public website and demo UI are available at `http://localhost:5173` in development. The admin console is at `http://localhost:5173/admin`. The API server runs at `http://localhost:8080`.

## Admin Bootstrap

The first server boot creates a single admin account from:

- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

Change these before deploying.

## Public API

```bash
curl -N http://localhost:8080/v1/research \
  -H "Authorization: Bearer awr_..." \
  -H "Content-Type: application/json" \
  -d '{"query":"how does the vercel ai sdk work with open ai compatible endpoints"}'
```

Responses are Server-Sent Events with typed JSON payloads.

## Website, Demo, and LLM Docs

The built app serves a public landing page at `/` with documentation, Helm install instructions, and a rate-limited live demo. Plain-text documentation for LLMs and agent clients is served at `/llms.txt`. The demo posts to `/v1/demo/research` and uses the same SSE event stream as the authenticated API, but with small server-side limits.

Demo controls are configured with:

- `DEMO_RESEARCH_ENABLED`
- `DEMO_RESEARCH_RATE_LIMIT_WINDOW_MS`
- `DEMO_RESEARCH_RATE_LIMIT_MAX`
- `DEMO_RESEARCH_MAX_CONCURRENCY`
- `DEMO_RESEARCH_MAX_DEPTH`
- `DEMO_RESEARCH_MAX_PAGES`
- `DEMO_RESEARCH_PAGE_TIMEOUT_MS`
- `DEMO_RESEARCH_TIMEOUT_MS`

## Helm chart repository

The chart source lives in `deploy/helm/agentic-web-research`. Packaged chart repo assets are served from `/charts` when `deploy/helm/repo` exists:

```bash
helm repo add agentic-web-research http://localhost:8080/charts
helm repo update
helm install awr agentic-web-research/agentic-web-research
```

Regenerate the package after chart changes:

```bash
bun run helm:package
```

## Deployment

- Docker Compose: `deploy/compose/docker-compose.yml`
- Helm chart: `deploy/helm/agentic-web-research`

The default deployment includes Postgres and SearXNG. The chart supports external Postgres and external SearXNG by values override.

