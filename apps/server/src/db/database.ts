import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import type { LlmConfig, ResearchDefaults, ResearchEventType } from "@agentic-web-research/core";
import { LlmConfigSchema, ResearchDefaultsSchema } from "@agentic-web-research/core";
import type { AppConfig } from "../config";
import { decryptSecret, encryptSecret } from "../utils/secrets";
import { migrations } from "./migrations";

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
    await this.setSettingIfMissing("llm", LlmConfigSchema.parse({}));
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

  async getLlmConfig(): Promise<LlmConfig> {
    const value = await this.getSetting<Record<string, unknown>>("llm", LlmConfigSchema.parse({}));
    const apiKeyEncrypted = value.apiKeyEncrypted;
    const parsed = LlmConfigSchema.parse({
      ...value,
      apiKey:
        typeof apiKeyEncrypted === "string"
          ? decryptSecret(apiKeyEncrypted, this.config.APP_SECRET)
          : typeof value.apiKey === "string"
            ? value.apiKey
            : undefined
    });
    return parsed;
  }

  async saveLlmConfig(value: LlmConfig) {
    const parsed = LlmConfigSchema.parse(value);
    const stored: Record<string, unknown> = {
      endpoint: parsed.endpoint,
      model: parsed.model,
      headers: parsed.headers,
      temperature: parsed.temperature,
      maxOutputTokens: parsed.maxOutputTokens
    };
    if (parsed.apiKey) {
      stored.apiKeyEncrypted = encryptSecret(parsed.apiKey, this.config.APP_SECRET);
    } else {
      const existing = await this.getSetting<Record<string, unknown>>("llm", {});
      if (typeof existing.apiKeyEncrypted === "string") {
        stored.apiKeyEncrypted = existing.apiKeyEncrypted;
      }
    }
    await this.setSetting("llm", stored);
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

  async insertTask(input: { apiKeyId: string; query: string; request: unknown }) {
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
