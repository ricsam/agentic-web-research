import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import type {
  LlmConfig,
  LlmSettings,
  OpenAiCompatibleProvider,
  OpenAiCompatibleProviderCreate,
  OpenAiCompatibleProviderUpdate,
  PublicLlmSettings,
  ResearchDefaults,
  ResearchEventType
} from "@agentic-web-research/core";
import {
  LlmConfigSchema,
  LlmSettingsSchema,
  OpenAiCompatibleProviderSchema,
  ResearchDefaultsSchema
} from "@agentic-web-research/core";
import type { AppConfig } from "../config";
import { decryptSecret, encryptSecret } from "../utils/secrets";
import { migrations } from "./migrations";

const DEFAULT_PROVIDER_ID = "default";

function defaultStoredLlmSettings() {
  return {
    providers: []
  };
}

export function isSecretHeaderName(name: string) {
  const normalized = name.trim().toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "proxy-authorization" ||
    normalized === "x-api-key" ||
    normalized.includes("api-key") ||
    normalized.includes("apikey") ||
    normalized.includes("auth") ||
    normalized.includes("token") ||
    normalized.includes("secret")
  );
}

function redactSecretHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, isSecretHeaderName(name) ? "" : value])
  );
}

function mergeHeadersPreservingRedactedSecrets(
  existingHeaders: Record<string, string>,
  nextHeaders: Record<string, string>
) {
  const existingByNormalizedName = new Map(
    Object.entries(existingHeaders).map(([name, value]) => [name.trim().toLowerCase(), value])
  );

  return Object.fromEntries(
    Object.entries(nextHeaders).map(([name, value]) => {
      const normalized = name.trim().toLowerCase();
      if (isSecretHeaderName(name) && value === "" && existingByNormalizedName.has(normalized)) {
        return [name.trim(), existingByNormalizedName.get(normalized) ?? value];
      }
      return [name.trim(), value];
    })
  );
}

function hasOwnProperty(object: object, key: string) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function hasProviderCredentials(provider: Pick<OpenAiCompatibleProvider, "apiKey" | "headers">) {
  return Boolean(provider.apiKey?.trim()) || Object.values(provider.headers).some((value) => value.trim().length > 0);
}

export class Database {
  private readonly pool: Pool;

  constructor(private readonly config: AppConfig) {
    this.pool = new Pool({ connectionString: config.DATABASE_URL });
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
    return this.pool.query<T>(sql, params);
  }

  async init() {
    await this.query(migrations);
    await this.seedSettings();
  }

  async close() {
    await this.pool.end();
  }

  async seedSettings() {
    await this.setSettingIfMissing("llm", defaultStoredLlmSettings());
    await this.setSettingIfMissing("research", ResearchDefaultsSchema.parse({}));
  }

  async setSettingIfMissing(key: string, value: unknown) {
    await this.query(
      `INSERT INTO settings (key, value)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)]
    );
  }

  private decryptApiKey(apiKeyEncrypted: unknown) {
    if (typeof apiKeyEncrypted !== "string") return undefined;
    return decryptSecret(apiKeyEncrypted, this.config.APP_SECRET);
  }

  private normalizeStoredLlmSettings(value: Record<string, unknown>): LlmSettings {
    if (Array.isArray(value.providers)) {
      const providers = value.providers.map((rawProvider) => {
        const provider = rawProvider && typeof rawProvider === "object" ? rawProvider as Record<string, unknown> : {};
        return OpenAiCompatibleProviderSchema.parse({
          ...provider,
          apiKey: this.decryptApiKey(provider.apiKeyEncrypted) ?? (typeof provider.apiKey === "string" ? provider.apiKey : undefined)
        });
      });
      const requestedActiveProviderId = typeof value.activeProviderId === "string" ? value.activeProviderId : undefined;
      const activeProviderId = providers.some((provider) => provider.id === requestedActiveProviderId)
        ? requestedActiveProviderId
        : providers[0]?.id;
      return LlmSettingsSchema.parse({ activeProviderId, providers });
    }

    const legacy = LlmConfigSchema.parse({
      ...value,
      apiKey: this.decryptApiKey(value.apiKeyEncrypted) ?? (typeof value.apiKey === "string" ? value.apiKey : undefined)
    });
    return LlmSettingsSchema.parse({
      activeProviderId: DEFAULT_PROVIDER_ID,
      providers: [
        {
          id: DEFAULT_PROVIDER_ID,
          name: "Default",
          endpoint: legacy.endpoint,
          model: legacy.model,
          apiKey: legacy.apiKey,
          headers: legacy.headers,
          temperature: legacy.temperature,
          maxOutputTokens: legacy.maxOutputTokens
        }
      ]
    });
  }

  private serializeLlmSettings(settings: LlmSettings) {
    return {
      activeProviderId: settings.activeProviderId,
      providers: settings.providers.map((provider) => {
        const stored: Record<string, unknown> = {
          id: provider.id,
          name: provider.name,
          endpoint: provider.endpoint,
          model: provider.model,
          headers: provider.headers,
          temperature: provider.temperature,
          maxOutputTokens: provider.maxOutputTokens,
          createdAt: provider.createdAt,
          updatedAt: provider.updatedAt
        };
        if (provider.apiKey) {
          stored.apiKeyEncrypted = encryptSecret(provider.apiKey, this.config.APP_SECRET);
        }
        return stored;
      })
    };
  }

  private async saveLlmSettingsInternal(settings: LlmSettings) {
    const parsed = LlmSettingsSchema.parse(settings);
    await this.setSetting("llm", this.serializeLlmSettings(parsed));
  }

  async getLlmSettings(): Promise<LlmSettings> {
    const value = await this.getSetting<Record<string, unknown>>("llm", defaultStoredLlmSettings());
    return this.normalizeStoredLlmSettings(value);
  }

  async getPublicLlmSettings(): Promise<PublicLlmSettings> {
    const settings = await this.getLlmSettings();
    return {
      activeProviderId: settings.activeProviderId,
      providers: settings.providers.map(({ apiKey, headers, temperature: _temperature, ...provider }) => ({
        ...provider,
        headers: redactSecretHeaders(headers),
        hasApiKey: Boolean(apiKey)
      }))
    };
  }

  async getActiveLlmProvider() {
    const settings = await this.getLlmSettings();
    const activeProvider = settings.providers.find((provider) => provider.id === settings.activeProviderId) ?? settings.providers[0];
    return activeProvider ?? null;
  }

  async createLlmProvider(input: OpenAiCompatibleProviderCreate) {
    const parsed = OpenAiCompatibleProviderSchema.omit({ id: true }).parse(input);
    const rawSettings = await this.getSetting<Record<string, unknown>>("llm", defaultStoredLlmSettings());
    const settings = this.normalizeStoredLlmSettings(rawSettings);
    const now = new Date().toISOString();
    const provider = OpenAiCompatibleProviderSchema.parse({
      ...parsed,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now
    });
    const nextSettings = LlmSettingsSchema.parse({
      activeProviderId: !settings.providers.length ? provider.id : settings.activeProviderId ?? provider.id,
      providers: [...settings.providers, provider]
    });
    await this.saveLlmSettingsInternal(nextSettings);
    return provider;
  }

  async updateLlmProvider(id: string, patch: OpenAiCompatibleProviderUpdate) {
    const settings = await this.getLlmSettings();
    const providerIndex = settings.providers.findIndex((provider) => provider.id === id);
    if (providerIndex === -1) return null;

    const existing = settings.providers[providerIndex];
    const nextProvider = OpenAiCompatibleProviderSchema.parse({
      ...existing,
      ...patch,
      headers: hasOwnProperty(patch, "headers")
        ? mergeHeadersPreservingRedactedSecrets(existing.headers, patch.headers ?? {})
        : existing.headers,
      apiKey: typeof patch.apiKey === "string" && patch.apiKey.trim() ? patch.apiKey : existing.apiKey,
      updatedAt: new Date().toISOString()
    });
    const providers = settings.providers.slice();
    providers[providerIndex] = nextProvider;
    await this.saveLlmSettingsInternal({ ...settings, providers });
    return nextProvider;
  }

  async deleteLlmProvider(id: string) {
    const settings = await this.getLlmSettings();
    if (settings.activeProviderId === id) {
      throw new Error("Cannot delete the active provider");
    }

    const providers = settings.providers.filter((provider) => provider.id !== id);
    if (providers.length === settings.providers.length) return false;
    await this.saveLlmSettingsInternal({
      activeProviderId: settings.activeProviderId,
      providers
    });
    return true;
  }

  async setActiveLlmProvider(id: string) {
    const settings = await this.getLlmSettings();
    const provider = settings.providers.find((candidate) => candidate.id === id);
    if (!provider) return null;
    await this.saveLlmSettingsInternal({ ...settings, activeProviderId: id });
    return provider;
  }

  async getLlmConfig(): Promise<LlmConfig> {
    const activeProvider = await this.getActiveLlmProvider();
    if (!activeProvider) return LlmConfigSchema.parse({});
    return LlmConfigSchema.parse(activeProvider);
  }

  async saveLlmConfig(value: LlmConfig) {
    const parsed = LlmConfigSchema.parse(value);
    const settings = await this.getLlmSettings();
    const activeProvider = settings.providers.find((provider) => provider.id === settings.activeProviderId) ?? settings.providers[0];

    if (!activeProvider) {
      await this.createLlmProvider({
        name: "Default",
        endpoint: parsed.endpoint,
        model: parsed.model,
        apiKey: parsed.apiKey,
        headers: parsed.headers,
        temperature: parsed.temperature,
        maxOutputTokens: parsed.maxOutputTokens
      });
      return;
    }

    await this.updateLlmProvider(activeProvider.id, parsed);
  }

  async getResearchDefaults(): Promise<ResearchDefaults> {
    const value = await this.getSetting("research", ResearchDefaultsSchema.parse({}));
    return ResearchDefaultsSchema.parse(value);
  }

  async saveResearchDefaults(value: ResearchDefaults) {
    await this.setSetting("research", ResearchDefaultsSchema.parse(value));
  }

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const result = await this.query<{ value: T }>("SELECT value FROM settings WHERE key = $1", [key]);
    return result.rows[0]?.value ?? fallback;
  }

  async setSetting(key: string, value: unknown) {
    await this.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
  }

  async insertTask(input: { apiKeyId: string | null; query: string; request: unknown }) {
    const id = randomUUID();
    await this.query(
      `INSERT INTO research_tasks (id, api_key_id, query, status, request_json)
       VALUES ($1, $2, $3, 'running', $4::jsonb)`,
      [id, input.apiKeyId, input.query, JSON.stringify(input.request)]
    );
    return id;
  }

  async addResearchEvent(taskId: string, type: ResearchEventType, payload: Record<string, unknown>) {
    await this.query(
      "INSERT INTO research_events (task_id, type, payload) VALUES ($1, $2, $3::jsonb)",
      [taskId, type, JSON.stringify(payload)]
    );
  }

  async completeTask(taskId: string, answer: string, stats: Record<string, unknown>) {
    await this.query(
      `UPDATE research_tasks
       SET status = 'completed', final_answer = $2, stats_json = $3::jsonb, updated_at = now(), completed_at = now()
       WHERE id = $1`,
      [taskId, answer, JSON.stringify(stats)]
    );
  }

  async failTask(taskId: string, error: string, stats: Record<string, unknown> = {}) {
    await this.query(
      `UPDATE research_tasks
       SET status = 'failed', error = $2, stats_json = $3::jsonb, updated_at = now(), completed_at = now()
       WHERE id = $1`,
      [taskId, error, JSON.stringify(stats)]
    );
  }

  async log(level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
    await this.query(
      "INSERT INTO service_logs (level, message, context) VALUES ($1, $2, $3::jsonb)",
      [level, message, JSON.stringify(context)]
    );
  }

  async recentLogs(limit = 100) {
    const result = await this.query(
      `SELECT id, level, message, context, created_at
       FROM service_logs
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  async recentTasks(limit = 50) {
    const result = await this.query(
      `SELECT id, query, status, final_answer, error, stats_json, created_at, completed_at
       FROM research_tasks
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  async usageStats() {
    const result = await this.query(`
      SELECT
        count(*)::int AS total_tasks,
        count(*) FILTER (WHERE status = 'completed')::int AS completed_tasks,
        count(*) FILTER (WHERE status = 'failed')::int AS failed_tasks,
        count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS tasks_24h
      FROM research_tasks
    `);
    const byKey = await this.query(`
      SELECT
        api_keys.id,
        api_keys.name,
        api_keys.prefix,
        count(research_tasks.id)::int AS tasks,
        max(research_tasks.created_at) AS last_task_at
      FROM api_keys
      LEFT JOIN research_tasks ON research_tasks.api_key_id = api_keys.id
      GROUP BY api_keys.id
      ORDER BY tasks DESC, api_keys.created_at DESC
    `);
    return { totals: result.rows[0], byKey: byKey.rows };
  }
}
