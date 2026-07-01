# OpenAI-compatible Provider UI Integration Plan

## Context

Current project: `agentic-web-research` Bun monorepo.

- Admin UI: `apps/admin` React/Vite/shadcn-style components, currently a single `LlmSettingsForm` in `apps/admin/src/App.tsx` with endpoint/model/API key/JSON headers.
- Server: `apps/server` Fastify + Postgres. LLM config is stored as a JSONB `settings` row under key `llm` via `Database.getLlmConfig()` / `saveLlmConfig()`.
- Research runtime: `apps/server/src/research/engine.ts` uses `createOpenAICompatible({ apiKey, baseURL: llm.endpoint, headers: llm.headers })` and `provider(llm.model)`.
- Shared schemas: `packages/core/src/index.ts` defines `LlmConfigSchema`.

Reference project inspected: `/home/r5d/.r5d/projects/ricsam-build-it-now/main`.

Relevant reference UI pieces:

- `src/app/components/AiProviderFormParts.tsx`
  - `HeaderEntry`, `createHeaderEntry`, `headersToEntries`, `headerEntriesToObject`
  - `HeadersEditor` key/value editor with Add Header and delete row
- `src/app/components/UserSettings.tsx`
  - `openai_compatible` connection creation/editing flow with name, base URL, headers, model catalog, active connection, test model
- `server/ai/claude-factory.ts`
  - OpenAI-compatible client creation uses `createOpenAICompatible({ name, baseURL, headers })`

## Goal

Replace the single raw JSON-header LLM settings form with an admin-managed OpenAI-compatible provider UI where admins can add and manage one or more providers by defining:

- provider/display name
- endpoint/base URL
- model id
- optional API key
- arbitrary HTTP headers as editable key/value rows
- temperature and max output tokens
- active provider selection

The active configured provider must be used by the research engine.

## Proposed behavior

1. Admin Settings tab shows an `OpenAI-compatible providers` card instead of the current single `LLM endpoint` card.
2. Admin can create a provider with endpoint, model, optional API key, and headers.
3. Admin can edit existing providers, including replacing API key without revealing stored secret.
4. Admin can set one provider active.
5. Admin can delete non-active providers. If deleting the active provider is allowed, server should choose a deterministic fallback or reject deletion; prefer rejecting active-provider deletion until another provider is activated.
6. Header editing should use key/value rows copied/adapted from the reference project, not a raw JSON textarea.
7. Duplicate non-empty header names should be rejected client-side and server-side.
8. API keys and secret-bearing headers should never be logged or returned in plaintext. The UI should show `hasApiKey` only.
9. Existing deployments with the legacy single `llm` JSON shape should continue working by transparently migrating/normalizing to a single default provider.
10. Health check should report the active provider model/endpoint and degrade if no active provider is usable.

## Data model and schema plan

Prefer keeping the existing `settings` table to avoid a structural migration. Store an expanded JSON object under key `llm`.

### Shared schemas in `packages/core/src/index.ts`

Add schemas/types while keeping `LlmConfigSchema` compatibility where practical:

- `HeaderMapSchema`: `z.record(z.string().trim().min(1), z.string())` or equivalent validation for non-empty header names.
- `OpenAiCompatibleProviderSchema`:
  - `id: string`
  - `name: string`
  - `endpoint: string.url()`
  - `model: string.min(1)`
  - `apiKey?: string`
  - `headers: Record<string,string>` default `{}`
  - `temperature: number` default current `0.2`
  - `maxOutputTokens: number` default current `4096`
  - optional `createdAt` / `updatedAt` ISO strings if useful for UI ordering
- `LlmSettingsSchema`:
  - `activeProviderId?: string`
  - `providers: OpenAiCompatibleProvider[]`
- Request schemas:
  - create provider: no `id`, server generates it
  - update provider: partial fields, optional `apiKey`
  - active provider: `{ providerId: string }`

Compatibility:

- Continue exporting `LlmConfigSchema` or alias it to the active-provider shape where existing code expects endpoint/model/header fields.
- Add helper functions if needed to convert legacy single-config values into the new provider settings.

## Server plan

### Database helpers in `apps/server/src/db/database.ts`

Add/replace LLM methods:

1. `getLlmSettings(): Promise<LlmSettings>`
   - Load `settings.key = 'llm'`.
   - If value has legacy shape (`endpoint`, `model`, `headers`, top-level `apiKeyEncrypted`), normalize to:
     - one provider with id like `default` or generated stable id
     - copy endpoint/model/headers/temperature/maxOutputTokens
     - decrypt top-level `apiKeyEncrypted` into provider `apiKey` for internal use
     - `activeProviderId` points to that provider
   - If value has new shape, decrypt per-provider `apiKeyEncrypted` into internal `apiKey`.
2. `getActiveLlmProvider()` returns the active provider with decrypted API key.
3. `getPublicLlmSettings()` or route-level sanitizer returns providers with `apiKey` removed and `hasApiKey` added.
4. `createLlmProvider(input)`:
   - generate id with `randomUUID()`
   - encrypt `apiKey` if provided
   - add to providers
   - if first provider, set active
5. `updateLlmProvider(id, patch)`:
   - update endpoint/model/name/headers/temperature/maxOutputTokens
   - if `apiKey` provided and non-empty, replace encrypted key
   - if `apiKey` omitted, preserve existing encrypted key
6. `deleteLlmProvider(id)`:
   - reject if active and more than zero providers remain, or require setting a fallback explicitly. Prefer reject with `400` and message `Cannot delete the active provider`.
7. `setActiveLlmProvider(id)` verifies provider exists.

Important: stored JSON should contain `apiKeyEncrypted`, not plaintext `apiKey`.

### Admin routes in `apps/server/src/routes/admin.ts`

Keep `GET /admin/api/settings/llm`, but change response to the new provider-settings payload.

Add routes:

- `POST /admin/api/settings/llm/providers`
- `PUT /admin/api/settings/llm/providers/:id`
- `DELETE /admin/api/settings/llm/providers/:id`
- `PUT /admin/api/settings/llm/active`

Optional but useful if time permits:

- `POST /admin/api/settings/llm/test`
  - Accept endpoint/model/apiKey/headers/temperature/maxOutputTokens or provider id.
  - Run a tiny `generateText` call and return success/error.

Logging:

- Log provider name/id, endpoint, model.
- Never log API key or header values.

### Research engine in `apps/server/src/research/engine.ts`

- Replace `const llm = await db.getLlmConfig()` with active-provider lookup.
- Treat provider usable if endpoint and model are configured and either API key or custom auth header exists.
- Construct:
  ```ts
  const provider = createOpenAICompatible({
    name: activeProvider.name || "admin-configured",
    apiKey: activeProvider.apiKey,
    baseURL: activeProvider.endpoint,
    headers: activeProvider.headers
  });
  ```
- Continue using provider model, temperature, and maxOutputTokens from the active provider.

### Health route

Update LLM health check to:

- report `ok` if active provider exists and has credentials/auth headers
- report `degraded` if no active provider or missing auth
- message should include model and endpoint, not secrets

## Admin UI plan

Main file: `apps/admin/src/App.tsx`.

1. Add types for provider settings:
   - `LlmProvider`
   - `PublicLlmProvider` with `hasApiKey`
   - `LlmSettings` with `activeProviderId` and `providers`
2. Replace `emptyLlm` single object with `emptyLlmSettings`.
3. Replace `LlmSettingsForm` with `LlmProvidersForm`.
4. Add/adapt from reference project:
   - `HeaderEntry`
   - `createHeaderEntry`
   - `headersToEntries`
   - `headerEntriesToObject`
   - `HeadersEditor`
5. Provider manager UI:
   - list providers with name, endpoint, model, active badge, has API key indicator
   - buttons: `Use`, `Edit`, `Delete`
   - create provider section with fields:
     - Name
     - Endpoint/Base URL
     - Model
     - API key
     - Temperature
     - Max output tokens
     - Headers editor rows
   - edit provider section with same fields; API key input placeholder `Existing key stored` when `hasApiKey`.
6. On save/create/update:
   - use `headerEntriesToObject`
   - show duplicate header error inline
   - call new admin APIs
   - refresh dashboard afterward
7. Keep `ResearchSettingsForm`, API keys, docs, health, activity, and test panels unchanged except for type references.

Component organization:

- For a small change, keep helper types/components in `App.tsx`.
- If `App.tsx` becomes too large, create `apps/admin/src/components/LlmProvidersForm.tsx` and import it.

## Backward compatibility details

Existing DB value likely looks like:

```json
{
  "endpoint": "https://api.openai.com/v1",
  "model": "gpt-4.1-mini",
  "headers": {},
  "temperature": 0.2,
  "maxOutputTokens": 4096,
  "apiKeyEncrypted": "..."
}
```

New DB value should look like:

```json
{
  "activeProviderId": "default",
  "providers": [
    {
      "id": "default",
      "name": "Default",
      "endpoint": "https://api.openai.com/v1",
      "model": "gpt-4.1-mini",
      "headers": {},
      "temperature": 0.2,
      "maxOutputTokens": 4096,
      "apiKeyEncrypted": "..."
    }
  ]
}
```

Normalization can happen in memory, but after first create/update it should persist the new shape.

## Validation and security

- Server validates URL, non-empty name/model, numeric limits, and header object.
- Server rejects duplicate/empty header names. JSON object duplicates cannot exist, so this mainly applies to UI before object conversion.
- API key is optional only if headers are non-empty; if no API key and no headers, mark health degraded and reject research run with a clear message.
- Sanitized responses include `hasApiKey`, never `apiKey` or `apiKeyEncrypted`.
- Avoid logging header values; if headers must be logged, log only header names.

## Test plan

Run after implementation:

```bash
bun test packages/core/src apps/server/src
bun run typecheck
bun run build
```

Add/update tests where practical:

- `packages/core/src/index.test.ts`
  - parses default `LlmSettingsSchema`
  - validates provider endpoint/model/defaults
  - rejects invalid endpoint
- `apps/server/src/...` unit tests if helpers are extracted:
  - legacy LLM config normalizes to provider settings
  - public sanitizer hides API keys
  - updating provider preserves encrypted API key when `apiKey` omitted
- Manual UI smoke test:
  - start dependencies: `docker compose -f deploy/compose/docker-compose.yml up -d postgres searxng`
  - run `bun run dev`
  - sign in, create provider, add headers using rows, set active, refresh, verify values persist and secrets stay hidden

## Acceptance criteria

- Admin can create and manage OpenAI-compatible providers through a row-based headers UI.
- Active provider selection persists.
- Research uses the selected active provider.
- Existing single LLM config installations do not break.
- API keys are encrypted at rest and never returned to the browser.
- Typecheck, tests, and build pass.
