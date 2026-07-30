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

## Agent APIs

Search and read a rendered page:

```bash
curl http://localhost:8080/v1/search \
  -H "Authorization: Bearer awr_..." \
  -H "Content-Type: application/json" \
  -d '{"query":"latest stable Bun release","limit":5}'

curl http://localhost:8080/v1/read \
  -H "Authorization: Bearer awr_..." \
  -H "Content-Type: application/json" \
  -d '{"url":"https://bun.sh/blog"}'
```

Run delegated research:

```bash
curl -N http://localhost:8080/v1/research \
  -H "Authorization: Bearer awr_..." \
  -H "Content-Type: application/json" \
  -d '{"query":"how does the vercel ai sdk work with open ai compatible endpoints"}'
```

Responses are Server-Sent Events with typed JSON payloads.
Clients can send `X-Research-Lease: required`, renew the lease with
`POST /v1/research/:taskId/heartbeat`, and explicitly stop active work with
`DELETE /v1/research/:taskId`.

All authenticated endpoints reject private, loopback, link-local, cluster-internal, and metadata URLs. `/healthz` is a process liveness check and `/readyz` verifies Postgres, SearXNG, Chromium, and LLM configuration.

For unattended deployments, `BOOTSTRAP_API_KEY` and the `BOOTSTRAP_LLM_*` environment variables idempotently configure the service on startup.

## Mintlify Docs

The Mintlify documentation project lives in `docs/`. It includes a quickstart, deployment guides, SSE event reference, and OpenAPI-generated endpoint pages.

Preview and validate it from the repository root:

```bash
bun run docs:dev
bun run docs:validate
```

To publish, connect this repository in Mintlify and set the documentation directory to `docs`. After assigning an application domain, update the OpenAPI server URL in `docs/openapi.json` and any production URLs used in examples.

## Website, Demo, and LLM Docs

The built app serves a public landing page at `/` with an API overview, Helm install instructions, and a rate-limited live demo. Plain-text documentation for LLMs and agent clients is served at `/llms.txt`. The demo posts to `/v1/demo/research` and uses the same SSE event stream as the authenticated API, but with small server-side limits.

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
kubectl create secret generic agentic-web-research-secrets \
  --from-literal=APP_SECRET='<long-random-value>' \
  --from-literal=ADMIN_PASSWORD='<admin-password>' \
  --from-literal=POSTGRES_PASSWORD='<database-password>' \
  --from-literal=BOOTSTRAP_API_KEY='<stable-agent-token>' \
  --from-literal=BOOTSTRAP_LLM_API_KEY='<model-api-key>' \
  --from-literal=BOOTSTRAP_LLM_HEADERS_JSON='{}' \
  --from-literal=SEARXNG_SECRET='<long-random-value>'
helm install awr agentic-web-research/agentic-web-research
```

The chart never generates or stores credential values. Set `existingSecret` if
you use a different Secret name.

Regenerate the package after chart changes:

```bash
bun run helm:package
```

## Deployment

- Docker Compose: `deploy/compose/docker-compose.yml`
- Helm chart: `deploy/helm/agentic-web-research`

The default deployment includes Postgres and SearXNG. The chart supports external Postgres and external SearXNG by values override.
