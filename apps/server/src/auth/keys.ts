import { createHash, randomBytes, randomUUID } from "node:crypto";
import { nanoid } from "nanoid";
import type { Database } from "../db/database";

export function hashApiKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

export function createPlainApiKey() {
  return `awr_${nanoid(40)}`;
}

export async function createApiKey(db: Database, name: string) {
  const plain = createPlainApiKey();
  const id = randomUUID();
  const prefix = plain.slice(0, 12);
  await db.query(
    `INSERT INTO api_keys (id, name, key_hash, prefix)
     VALUES ($1, $2, $3, $4)`,
    [id, name, hashApiKey(plain), prefix]
  );
  return { id, name, key: plain, prefix };
}

export async function verifyApiKey(db: Database, authorizationHeader: string | undefined) {
  const token = authorizationHeader?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const result = await db.query<{ id: string; name: string; prefix: string }>(
    `SELECT id, name, prefix
     FROM api_keys
     WHERE key_hash = $1 AND revoked_at IS NULL`,
    [hashApiKey(token)]
  );

  const apiKey = result.rows[0];
  if (!apiKey) return null;

  await db.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [apiKey.id]);
  return apiKey;
}

export function constantTimeToken() {
  return randomBytes(32).toString("hex");
}

