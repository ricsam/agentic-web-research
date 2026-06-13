# agentic-web-research

Self-hosted web research service for AI agents. It exposes an authenticated REST API that streams research progress, bundles SearXNG for search, renders pages with Playwright, converts pages to Markdown, and uses the Vercel AI SDK with an OpenAI-compatible endpoint to decide what to inspect next.

## Quick Start

```bash
bun install
cp .env.example .env
docker compose -f deploy/compose/docker-compose.yml up -d postgres searxng
bun run dev
```

The admin UI is available at `http://localhost:5173` in development. The API server runs at `http://localhost:8080`.

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

## Deployment

- Docker Compose: `deploy/compose/docker-compose.yml`
- Helm chart: `deploy/helm/agentic-web-research`

The default deployment includes Postgres and SearXNG. The chart supports external Postgres and external SearXNG by values override.

