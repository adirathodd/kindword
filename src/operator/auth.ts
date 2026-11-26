// Operator sign-in (SPEC Security: "Operator login uses a strong password plus two-factor authentication"; FR-1).
// One operator, configured by env: OPERATOR_EMAIL, OPERATOR_PASSWORD_HASH (an Argon2id hash made by
// `npm run operator:setup`, never the password) and OPERATOR_TOTP_SECRET (base32, for an authenticator app). With
// any of them missing, operator sign-in is off. A wrong email, password or code all get the same answer; guesses
// are rate-limited per IP; each authenticator code opens at most one session (operator_sessions.totp_step is unique).
// Sessions last 12 hours and store only a SHA-256 of the cookie secret. Audit rows carry IDs only.
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { allow, normalizeEmail } from "../accounts/accounts";
import { dummyHash, verifyPassword } from "../accounts/password";
import { db as defaultDb, type Db } from "../db/client";
import { auditLog, operatorSessions } from "../db/schema";
import { looksLikeSecret } from "../inbox/auth";
import { base32Decode, verifyTotp } from "./totp";

export const OPERATOR_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export type OperatorConfig = { email: string; passwordHash: string; totpSecret: string };

// Names the first missing or malformed setting, never its value.
export function operatorConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): { ok: true; config: OperatorConfig } | { ok: false; missing: string } {
  const email = normalizeEmail(env.OPERATOR_EMAIL ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, missing: "OPERATOR_EMAIL" };
  const passwordHash = env.OPERATOR_PASSWORD_HASH?.trim() ?? "";
  if (!/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[\w-]+\$[\w-]+$/.test(passwordHash))
    return { ok: false, missing: "OPERATOR_PASSWORD_HASH" };
  const totpSecret = env.OPERATOR_TOTP_SECRET?.trim() ?? "";
  const key = base32Decode(totpSecret);
  if (!key || key.length < 16) return { ok: false, missing: "OPERATOR_TOTP_SECRET" }; // at least 128 bits
  return { ok: true, config: { email, passwordHash, totpSecret } };
}

export type OperatorSignInResult =
  { ok: true; secret: string; expiresAt: Date } | { ok: false; reason: "invalid" | "limited" | "disabled" };

export async function operatorSignIn(
  input: { email: string; password: string; code: string },
  ip: string,
  deps: { config: OperatorConfig | null; now?: Date },
  db: Db = defaultDb,
): Promise<OperatorSignInResult> {
  const now = deps.now ?? new Date();
  const config = deps.config;
  if (!config) return { ok: false, reason: "disabled" };
  if (!(await allow("operatorSignInIp", ip, now, db))) return { ok: false, reason: "limited" };
  // The password is always checked, so a wrong email takes as long as a wrong password.
  const emailOk = normalizeEmail(input.email) === config.email;
  const passwordOk = await verifyPassword(
    input.password.slice(0, 1024),
    emailOk ? config.passwordHash : await dummyHash(),
  );
  const step = verifyTotp(config.totpSecret, input.code.trim(), now);
  if (!emailOk || !passwordOk || step === null) return { ok: false, reason: "invalid" };

  const secret = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + OPERATOR_SESSION_TTL_MS);
  // A code already used for a session (replay) inserts nothing.
  const [row] = await db
    .insert(operatorSessions)
    .values({ sessionTokenHash: sha256(secret), totpStep: step, createdAt: now, expiresAt })
    .onConflictDoNothing({ target: operatorSessions.totpStep })
    .returning({ id: operatorSessions.id });
  if (!row) return { ok: false, reason: "invalid" };
  await db
    .insert(auditLog)
    .values({ entity: "operator", entityId: row.id, action: "signed_in", actor: "operator", at: now });
  return { ok: true, secret, expiresAt };
}

export type OperatorSession = { sessionId: string };

export async function getOperatorSession(
  secret: string | undefined | null,
  opts: { now?: Date } = {},
  db: Db = defaultDb,
): Promise<OperatorSession | null> {
  if (!looksLikeSecret(secret)) return null;
  const now = opts.now ?? new Date();
  const [row] = await db
    .select({ sessionId: operatorSessions.id })
    .from(operatorSessions)
    .where(
      and(
        eq(operatorSessions.sessionTokenHash, sha256(secret)),
        gt(operatorSessions.expiresAt, now),
        isNull(operatorSessions.revokedAt),
      ),
    );
  return row ?? null;
}

export async function operatorSignOut(
  secret: string | undefined | null,
  opts: { now?: Date } = {},
  db: Db = defaultDb,
) {
  if (!looksLikeSecret(secret)) return;
  const now = opts.now ?? new Date();
  const [row] = await db
    .update(operatorSessions)
    .set({ revokedAt: now })
    .where(and(eq(operatorSessions.sessionTokenHash, sha256(secret)), isNull(operatorSessions.revokedAt)))
    .returning({ id: operatorSessions.id });
  if (row)
    await db
      .insert(auditLog)
      .values({ entity: "operator", entityId: row.id, action: "signed_out", actor: "operator", at: now });
}
