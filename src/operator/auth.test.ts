// Operator sign-in (SPEC Security: "Operator login uses a strong password plus two-factor authentication"). Runs
// against the Postgres in DATABASE_URL. Fake data only.
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../accounts/password";
import { db } from "../db/client";
import * as s from "../db/schema";
import {
  OPERATOR_SESSION_TTL_MS,
  getOperatorSession,
  operatorConfigFromEnv,
  operatorSignIn,
  operatorSignOut,
  type OperatorConfig,
} from "./auth";
import { TOTP_PERIOD_S, generateTotpSecret, totpCode } from "./totp";

const PW = "operator test password 123";
let config: OperatorConfig;
let ip = 0;
const RUN = Math.floor(Math.random() * 250); // rate-limit rows from earlier runs stay in the database
let clock = Date.now(); // each test moves on 10 time steps, so codes and rate limits never collide
const next = () => {
  clock += 10 * TOTP_PERIOD_S * 1000;
  ip++;
  return new Date(clock);
};
const code = (now: Date, offset = 0) =>
  totpCode(config.totpSecret, Math.floor(now.getTime() / 1000 / TOTP_PERIOD_S) + offset);
const signIn = (now: Date, over: Partial<{ email: string; password: string; code: string; ip: string }> = {}) =>
  operatorSignIn(
    { email: over.email ?? "Ops@Example.test ", password: over.password ?? PW, code: over.code ?? code(now) },
    over.ip ?? `10.9.${RUN}.${ip}`,
    { config, now },
  );

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
  config = { email: "ops@example.test", passwordHash: await hashPassword(PW), totpSecret: generateTotpSecret() };
});
afterEach(async () => {
  await db.delete(s.operatorSessions);
});

describe("operatorConfigFromEnv", () => {
  it("needs all three settings, and names what is missing without echoing values", () => {
    const env = {
      OPERATOR_EMAIL: " ops@example.test ",
      OPERATOR_PASSWORD_HASH:
        "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g",
      OPERATOR_TOTP_SECRET: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    };
    expect(operatorConfigFromEnv(env)).toEqual({
      ok: true,
      config: {
        email: "ops@example.test",
        passwordHash: env.OPERATOR_PASSWORD_HASH,
        totpSecret: env.OPERATOR_TOTP_SECRET,
      },
    });
    expect(operatorConfigFromEnv({ ...env, OPERATOR_TOTP_SECRET: "" })).toEqual({
      ok: false,
      missing: "OPERATOR_TOTP_SECRET",
    });
    expect(operatorConfigFromEnv({ ...env, OPERATOR_TOTP_SECRET: "SHORT" })).toEqual({
      ok: false,
      missing: "OPERATOR_TOTP_SECRET",
    });
    expect(operatorConfigFromEnv({ ...env, OPERATOR_PASSWORD_HASH: "plain password" })).toEqual({
      ok: false,
      missing: "OPERATOR_PASSWORD_HASH",
    });
    expect(operatorConfigFromEnv({ ...env, OPERATOR_EMAIL: "nope" })).toEqual({ ok: false, missing: "OPERATOR_EMAIL" });
  });
});

describe("operatorSignIn", () => {
  it("opens a 12-hour session with the right email, password and code, storing only a hash", async () => {
    const now = next();
    const r = await signIn(now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.secret).toMatch(/^[\w-]{43}$/);
    expect(r.expiresAt).toEqual(new Date(now.getTime() + OPERATOR_SESSION_TTL_MS));
    expect(OPERATOR_SESSION_TTL_MS).toBe(12 * 60 * 60 * 1000);
    const rows = await db.select().from(s.operatorSessions);
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionTokenHash).not.toContain(r.secret);
    expect(await getOperatorSession(r.secret, { now })).toEqual({ sessionId: rows[0].id });
    const audit = await db.select().from(s.auditLog).where(eq(s.auditLog.entityId, rows[0].id));
    expect(audit.map((a) => [a.entity, a.action, a.actor])).toEqual([["operator", "signed_in", "operator"]]);
  });

  it("gives the same answer for a wrong email, password or code", async () => {
    const now = next();
    for (const over of [{ email: "other@example.test" }, { password: "wrong password 1234" }, { code: "000000" }])
      expect(await signIn(now, over)).toEqual({ ok: false, reason: "invalid" });
    expect(await db.select().from(s.operatorSessions)).toEqual([]);
  });

  it("accepts a code from one step either side (clock drift) but never the same code twice", async () => {
    const now = next();
    expect((await signIn(now, { code: code(now, -1) })).ok).toBe(true);
    expect(await signIn(now, { code: code(now, -1) })).toEqual({ ok: false, reason: "invalid" });
    expect((await signIn(now, { code: code(now) })).ok).toBe(true);
    expect(await signIn(now, { code: code(now, 2) })).toEqual({ ok: false, reason: "invalid" });
  });

  it("is switched off when the operator settings are missing", async () => {
    const now = next();
    const r = await operatorSignIn({ email: config.email, password: PW, code: code(now) }, "10.9.9.9", {
      config: null,
      now,
    });
    expect(r).toEqual({ ok: false, reason: "disabled" });
  });

  it("rate-limits guesses per IP", async () => {
    const now = next();
    const guesser = `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`; // fresh per run
    const reasons: string[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await signIn(now, { code: "000000", ip: guesser });
      reasons.push(r.ok ? "ok" : r.reason);
    }
    expect(reasons.slice(0, 10)).toEqual(Array(10).fill("invalid"));
    expect(reasons[10]).toBe("limited");
    // Even the right code is refused from that IP while limited.
    expect(await signIn(now, { ip: guesser })).toEqual({ ok: false, reason: "limited" });
  });
});

describe("operator sessions", () => {
  it("expire after 12 hours, end at sign-out, and ignore malformed cookies", async () => {
    const now = next();
    const r = await signIn(now);
    if (!r.ok) throw new Error("sign-in failed");
    expect(await getOperatorSession(r.secret, { now: new Date(r.expiresAt.getTime() - 1) })).not.toBeNull();
    expect(await getOperatorSession(r.secret, { now: r.expiresAt })).toBeNull();
    await operatorSignOut(r.secret, { now });
    expect(await getOperatorSession(r.secret, { now })).toBeNull();
    for (const bad of [undefined, null, "", "x", "a".repeat(44)])
      expect(await getOperatorSession(bad, { now })).toBeNull();
  });
});
