import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { jwtVerify, SignJWT } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config";
import type { Database } from "../db/database";

const cookieName = "awr_admin";

export type AdminSession = {
  sub: string;
  email: string;
};

function secretKey(config: AppConfig) {
  return new TextEncoder().encode(config.APP_SECRET);
}

export async function seedAdminUser(db: Database, config: AppConfig) {
  const existing = await db.query("SELECT id FROM admin_users LIMIT 1");
  if (existing.rowCount) return;

  const passwordHash = await bcrypt.hash(config.ADMIN_PASSWORD, 12);
  await db.query(
    `INSERT INTO admin_users (id, email, password_hash)
     VALUES ($1, $2, $3)`,
    [randomUUID(), config.ADMIN_EMAIL.toLowerCase(), passwordHash]
  );
  await db.log("warn", "Seeded initial admin account", { email: config.ADMIN_EMAIL });
}

export async function verifyAdminCredentials(db: Database, email: string, password: string) {
  const result = await db.query<{ id: string; email: string; password_hash: string }>(
    "SELECT id, email, password_hash FROM admin_users WHERE email = $1",
    [email.toLowerCase()]
  );
  const user = result.rows[0];
  if (!user) return null;
  const valid = await bcrypt.compare(password, user.password_hash);
  return valid ? { id: user.id, email: user.email } : null;
}

export async function signAdminSession(config: AppConfig, session: AdminSession) {
  return new SignJWT({ email: session.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.sub)
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(secretKey(config));
}

export async function readAdminSession(config: AppConfig, request: FastifyRequest): Promise<AdminSession | null> {
  const token = request.cookies[cookieName];
  if (!token) return null;
  try {
    const result = await jwtVerify(token, secretKey(config));
    const email = result.payload.email;
    if (typeof result.payload.sub !== "string" || typeof email !== "string") return null;
    return { sub: result.payload.sub, email };
  } catch {
    return null;
  }
}

export async function requireAdmin(config: AppConfig, request: FastifyRequest, reply: FastifyReply) {
  const session = await readAdminSession(config, request);
  if (!session) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
  return session;
}

export function setAdminCookie(reply: FastifyReply, token: string, secure: boolean) {
  reply.setCookie(cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 60 * 60 * 8
  });
}

export function clearAdminCookie(reply: FastifyReply, secure: boolean) {
  reply.clearCookie(cookieName, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/"
  });
}

