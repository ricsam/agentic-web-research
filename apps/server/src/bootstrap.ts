import { createHash } from "node:crypto";
import type { AppConfig } from "./config";
import { getBootstrapLlmHeaders } from "./config";
import type { Database } from "./db/database";

const R5D_API_KEY_ID = "r5d-platform";
const R5D_LLM_PROVIDER_ID = "r5d-platform";

export async function bootstrapServiceConfiguration(db: Database, config: AppConfig) {
  if (config.BOOTSTRAP_API_KEY) {
    const prefix = config.BOOTSTRAP_API_KEY.slice(0, 12);
    const keyHash = createHash("sha256").update(config.BOOTSTRAP_API_KEY).digest("hex");
    await db.query(
      `INSERT INTO api_keys (id, name, key_hash, prefix, revoked_at)
       VALUES ($1, $2, $3, $4, NULL)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         key_hash = EXCLUDED.key_hash,
         prefix = EXCLUDED.prefix,
         revoked_at = NULL`,
      [R5D_API_KEY_ID, "r5d platform", keyHash, prefix]
    );
  }

  if (config.BOOTSTRAP_LLM_ENDPOINT && config.BOOTSTRAP_LLM_MODEL) {
    await db.upsertBootstrapLlmProvider({
      id: R5D_LLM_PROVIDER_ID,
      name: "r5d platform",
      endpoint: config.BOOTSTRAP_LLM_ENDPOINT,
      model: config.BOOTSTRAP_LLM_MODEL,
      apiKey: config.BOOTSTRAP_LLM_API_KEY,
      headers: getBootstrapLlmHeaders(config),
      temperature: config.BOOTSTRAP_LLM_TEMPERATURE,
      maxOutputTokens: config.BOOTSTRAP_LLM_MAX_OUTPUT_TOKENS
    });
  }
}
