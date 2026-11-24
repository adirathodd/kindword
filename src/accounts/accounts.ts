// Self-serve owner accounts (SPEC FR-24, Flow 0): sign-up, email verification, sign-in, password reset, sessions.
// Sign-up creates the business in onboarding status; nothing imports or sends until the operator switches it to live.
// Sign-up, sign-in and reset answer the same way whether or not the email has an account, and are rate-limited.
// Tokens and session secrets are random, stored only as SHA-256 hashes. Audit rows carry IDs only.
import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, isNull, lt, sql, TransactionRollbackError } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import {
  accountSessions,
  accountTokens,
  auditLog,
  authAttempts,
  businesses,
  locations,
  ownerAccounts,
  ownerSessions,
} from "../db/schema";
import type { EmailProvider } from "../email/provider";
import { escapeHtml, looksLikeSecret, SESSION_TTL_MS } from "../inbox/auth";
import { dummyHash, hashPassword, passwordProblem, verifyPassword, type BreachChecker } from "./password";

const MINUTE = 60 * 1000;
export const VERIFY_TTL_MS = 24 * 60 * MINUTE;
export const RESET_TTL_MS = 15 * MINUTE;
export const ACCOUNT_SESSION_TTL_MS = SESSION_TTL_MS; // 30 days, like inbox sessions
// Version of the terms and privacy policy shown on the sign-up page; bump when they change.
export const TERMS_VERSION = "2026-11-23";

const newSecret = () => randomBytes(32).toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
export const normalizeEmail = (s: string) => s.trim().toLowerCase();

export type Deps = { email: EmailProvider; breach: BreachChecker; baseUrl: string; operatorEmail?: string; now?: Date };
export type AccountSession = { sessionId: string; accountId: string; businessId: string };

// ---- rate limits ----------------------------------------------------------------------------------------------

export const LIMITS = {
  signUpIp: { max: 5, windowMs: 60 * MINUTE },
  signUpEmail: { max: 5, windowMs: 60 * MINUTE },
  signInIp: { max: 30, windowMs: 15 * MINUTE },
  signInEmail: { max: 10, windowMs: 15 * MINUTE },
  resetIp: { max: 10, windowMs: 60 * MINUTE },
  resetEmail: { max: 5, windowMs: 60 * MINUTE },
} as const;
type Limit = keyof typeof LIMITS;

// Records one attempt and says whether it is within the limit. Old rows are cleared as a side effect.
// shortcut: count-then-insert can let a burst of parallel requests slightly overshoot; fine for abuse limits.
export async function allow(limit: Limit, value: string, now = new Date(), db: Db = defaultDb) {
  const { max, windowMs } = LIMITS[limit];
  const key = sha256(`${limit}:${value}`);
  const since = new Date(now.getTime() - windowMs);
  await db.delete(authAttempts).where(lt(authAttempts.at, new Date(now.getTime() - 24 * 60 * MINUTE)));
  const [{ n }] = await db
    .select({ n: count() })
    .from(authAttempts)
    .where(and(eq(authAttempts.key, key), gt(authAttempts.at, since)));
  await db.insert(authAttempts).values({ key, at: now });
  return n < max;
}

// ---- tokens, sessions, email ----------------------------------------------------------------------------------

async function newToken(accountId: string, purpose: "verify_email" | "reset_password", now: Date, db: Db) {
  const token = newSecret();
  const ttl = purpose === "verify_email" ? VERIFY_TTL_MS : RESET_TTL_MS;
  await db
    .insert(accountTokens)
    .values({ accountId, purpose, tokenHash: sha256(token), expiresAt: new Date(now.getTime() + ttl) });
  return token;
}

// Uses a token once, within its lifetime. Atomic, so two clicks cannot both succeed.
async function redeemToken(token: string, purpose: "verify_email" | "reset_password", now: Date, db: Db) {
  if (!looksLikeSecret(token)) return null;
  const [row] = await db
    .update(accountTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(accountTokens.tokenHash, sha256(token)),
        eq(accountTokens.purpose, purpose),
        isNull(accountTokens.usedAt),
        gt(accountTokens.expiresAt, now),
      ),
    )
    .returning({ accountId: accountTokens.accountId });
  return row?.accountId ?? null;
}

async function startSession(accountId: string, now: Date, db: Db) {
  const secret = newSecret();
  const expiresAt = new Date(now.getTime() + ACCOUNT_SESSION_TTL_MS);
  const [row] = await db
    .insert(accountSessions)
    .values({ accountId, sessionTokenHash: sha256(secret), expiresAt })
    .returning({ id: accountSessions.id });
  await audit(accountId, "signed_in", `owner_account:${accountId}`, db);
  return { secret, expiresAt, sessionId: row.id };
}

const audit = (accountId: string, action: string, actor: string, db: Pick<Db, "insert">) =>
  db.insert(auditLog).values({ entity: "owner_account", entityId: accountId, action, actor });

async function mail(deps: Deps, to: string, subject: string, lines: string[], link?: { url: string; label: string }) {
  const text = [...lines, ...(link ? ["", link.url] : []), "", "If you did not expect this email, you can ignore it."];
  const html = `${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("")}${
    link ? `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>` : ""
  }<p>If you did not expect this email, you can ignore it.</p>`;
  await deps.email.send({ to, fromName: "Kindword", subject, text: text.join("\n"), html, headers: {} });
}

const sendVerify = async (deps: Deps, accountId: string, to: string, now: Date, db: Db) =>
  mail(
    deps,
    to,
    "Confirm your email for Kindword",
    ["Confirm your email address to finish creating your Kindword account. The link works once, for 24 hours."],
    {
      url: `${deps.baseUrl}/account/verify/${await newToken(accountId, "verify_email", now, db)}`,
      label: "Confirm email",
    },
  );

// ---- sign-up --------------------------------------------------------------------------------------------------

export type SignUpInput = { name: string; businessName: string; email: string; password: string; terms: boolean };
export type SignUpResult = { ok: true } | { ok: false; error: string } | { ok: false; limited: true };

// ok:true means "check your email" whether the account is new or the email already had one (then that owner gets a
// note instead of a second account).
export async function signUp(input: SignUpInput, ip: string, deps: Deps, db: Db = defaultDb): Promise<SignUpResult> {
  const now = deps.now ?? new Date();
  const name = input.name.trim();
  const businessName = input.businessName.trim();
  const email = normalizeEmail(input.email);
  if (!name || name.length > 200) return { ok: false, error: "Enter your name." };
  if (!businessName || businessName.length > 200) return { ok: false, error: "Enter your business name." };
  if (email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };
  const weak = passwordProblem(input.password);
  if (weak) return { ok: false, error: weak };
  if (!input.terms) return { ok: false, error: "Accept the terms and privacy policy to continue." };
  // FR-24: per IP and per email. Each sign-up emails the address (a link, or "already has an account"), so without
  // the per-email limit sign-ups from many IPs could flood one owner's inbox. Both are counted on every attempt.
  const okIp = await allow("signUpIp", ip, now, db);
  const okEmail = await allow("signUpEmail", email, now, db);
  if (!okIp || !okEmail) return { ok: false, limited: true };
  if (await deps.breach.isBreached(input.password))
    return { ok: false, error: "That password has appeared in a data breach. Choose a different one." };

  const passwordHash = await hashPassword(input.password);
  const created = await db
    .transaction(async (tx) => {
      const [taken] = await tx
        .select({ id: ownerAccounts.id })
        .from(ownerAccounts)
        .where(eq(ownerAccounts.normalizedEmail, email));
      if (taken) return null;
      const [b] = await tx
        .insert(businesses)
        .values({ name: businessName, vertical: "home_services", ownerName: name, ownerEmail: email })
        .returning({ id: businesses.id });
      const [a] = await tx
        .insert(ownerAccounts)
        .values({
          businessId: b.id,
          name,
          email: input.email.trim(),
          normalizedEmail: email,
          passwordHash,
          termsVersion: TERMS_VERSION,
          termsAcceptedAt: now,
        })
        .onConflictDoNothing({ target: ownerAccounts.normalizedEmail })
        .returning({ id: ownerAccounts.id });
      if (!a) {
        tx.rollback(); // lost a race with a parallel sign-up for the same email
        return null;
      }
      await audit(a.id, "signed_up", `owner_account:${a.id}`, tx);
      return { accountId: a.id, businessId: b.id };
    })
    .catch((e) => {
      if (e instanceof TransactionRollbackError) return null;
      throw e;
    });

  if (!created) {
    await mail(
      deps,
      email,
      "Someone tried to create a Kindword account with your email",
      [
        "Someone tried to create a Kindword account with this email address, which already has one.",
        "If it was you, sign in, or reset your password if you have forgotten it.",
      ],
      { url: `${deps.baseUrl}/account/sign-in`, label: "Sign in" },
    );
    return { ok: true };
  }
  await sendVerify(deps, created.accountId, email, now, db);
  if (deps.operatorEmail)
    await mail(deps, deps.operatorEmail, `New sign-up: ${businessName}`, [
      `A new business signed up and is waiting for onboarding (business ID ${created.businessId}).`,
    ]);
  return { ok: true };
}

// ---- verification ---------------------------------------------------------------------------------------------

export async function verifyEmail(token: string, opts: { now?: Date } = {}, db: Db = defaultDb) {
  const now = opts.now ?? new Date();
  const accountId = await redeemToken(token, "verify_email", now, db);
  if (!accountId) return null;
  const [a] = await db
    .update(ownerAccounts)
    .set({ emailVerifiedAt: now })
    .where(and(eq(ownerAccounts.id, accountId), isNull(ownerAccounts.disabledAt)))
    .returning({ id: ownerAccounts.id });
  if (!a) return null;
  await audit(a.id, "email_verified", `owner_account:${a.id}`, db);
  return startSession(a.id, now, db);
}

// ---- sign-in --------------------------------------------------------------------------------------------------

export type SignInResult =
  { ok: true; secret: string; expiresAt: Date } | { ok: false; reason: "invalid" | "limited" | "unverified" };

export async function signIn(
  input: { email: string; password: string },
  ip: string,
  deps: Deps,
  db: Db = defaultDb,
): Promise<SignInResult> {
  const now = deps.now ?? new Date();
  const email = normalizeEmail(input.email);
  const okIp = await allow("signInIp", ip, now, db);
  const okEmail = await allow("signInEmail", email, now, db);
  if (!okIp || !okEmail) return { ok: false, reason: "limited" };
  const [a] = await db
    .select({ id: ownerAccounts.id, hash: ownerAccounts.passwordHash, verified: ownerAccounts.emailVerifiedAt })
    .from(ownerAccounts)
    .where(and(eq(ownerAccounts.normalizedEmail, email), isNull(ownerAccounts.disabledAt)));
  const good = await verifyPassword(input.password.slice(0, 1024), a?.hash ?? (await dummyHash()));
  if (!a || !good) return { ok: false, reason: "invalid" };
  // Only someone who knows the password learns the account is unverified; they get a fresh link.
  if (!a.verified) {
    await sendVerify(deps, a.id, email, now, db);
    return { ok: false, reason: "unverified" };
  }
  const s = await startSession(a.id, now, db);
  return { ok: true, secret: s.secret, expiresAt: s.expiresAt };
}

export async function getAccountSession(
  secret: string | undefined | null,
  opts: { now?: Date } = {},
  db: Db = defaultDb,
) {
  if (!looksLikeSecret(secret)) return null;
  const now = opts.now ?? new Date();
  const [row] = await db
    .select({ sessionId: accountSessions.id, accountId: ownerAccounts.id, businessId: ownerAccounts.businessId })
    .from(accountSessions)
    .innerJoin(ownerAccounts, eq(ownerAccounts.id, accountSessions.accountId))
    .where(
      and(
        eq(accountSessions.sessionTokenHash, sha256(secret)),
        gt(accountSessions.expiresAt, now),
        isNull(accountSessions.revokedAt),
        isNull(ownerAccounts.disabledAt),
      ),
    );
  return (row ?? null) as AccountSession | null;
}

export async function signOutAccount(secret: string | undefined | null, db: Db = defaultDb) {
  if (!looksLikeSecret(secret)) return;
  const [row] = await db
    .update(accountSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(accountSessions.sessionTokenHash, sha256(secret)), isNull(accountSessions.revokedAt)))
    .returning({ accountId: accountSessions.accountId });
  if (row) await audit(row.accountId, "signed_out", `owner_account:${row.accountId}`, db);
}

// ---- password reset -------------------------------------------------------------------------------------------

// Always "check your email" unless rate-limited; only an existing, enabled account gets a link.
export async function requestReset(emailInput: string, ip: string, deps: Deps, db: Db = defaultDb) {
  const now = deps.now ?? new Date();
  const email = normalizeEmail(emailInput);
  const okIp = await allow("resetIp", ip, now, db);
  const okEmail = await allow("resetEmail", email, now, db);
  if (!okIp || !okEmail) return { ok: false as const, limited: true as const };
  const [a] = await db
    .select({ id: ownerAccounts.id })
    .from(ownerAccounts)
    .where(and(eq(ownerAccounts.normalizedEmail, email), isNull(ownerAccounts.disabledAt)));
  if (a)
    await mail(
      deps,
      email,
      "Reset your Kindword password",
      ["Use this link to choose a new password. It works once, for 15 minutes."],
      {
        url: `${deps.baseUrl}/account/reset/${await newToken(a.id, "reset_password", now, db)}`,
        label: "Choose a new password",
      },
    );
  return { ok: true as const };
}

export type ResetResult = { ok: true; secret: string; expiresAt: Date } | { ok: false; error: string } | null;

// Sets a new password from a reset link. Ends every other session (account and inbox) and signs this device in.
// A reset also counts as email verification: the owner proved they read the inbox. null = link invalid.
export async function resetPassword(
  token: string,
  password: string,
  deps: Deps,
  db: Db = defaultDb,
): Promise<ResetResult> {
  const now = deps.now ?? new Date();
  if (!looksLikeSecret(token)) return null;
  const weak = passwordProblem(password);
  if (weak) return { ok: false, error: weak };
  if (await deps.breach.isBreached(password))
    return { ok: false, error: "That password has appeared in a data breach. Choose a different one." };
  const passwordHash = await hashPassword(password);
  const accountId = await redeemToken(token, "reset_password", now, db);
  if (!accountId) return null;
  await db
    .update(ownerAccounts)
    .set({ passwordHash, emailVerifiedAt: sql`coalesce(${ownerAccounts.emailVerifiedAt}, ${now})` })
    .where(eq(ownerAccounts.id, accountId));
  await db
    .update(accountSessions)
    .set({ revokedAt: now })
    .where(and(eq(accountSessions.accountId, accountId), isNull(accountSessions.revokedAt)));
  await db
    .update(ownerSessions)
    .set({ revokedAt: now })
    .where(and(eq(ownerSessions.accountId, accountId), isNull(ownerSessions.revokedAt)));
  await audit(accountId, "password_reset", `owner_account:${accountId}`, db);
  const s = await startSession(accountId, now, db);
  return { ok: true, secret: s.secret, expiresAt: s.expiresAt };
}

// ---- account page and inbox hand-off ----------------------------------------------------------------------------

export async function accountOverview(session: AccountSession, db: Db = defaultDb) {
  const [b] = await db
    .select({ name: businesses.name, status: businesses.status })
    .from(businesses)
    .where(eq(businesses.id, session.businessId));
  const locs = await db
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(eq(locations.businessId, session.businessId))
    .orderBy(locations.name);
  return { businessName: b.name, status: b.status, locations: locs };
}

// Opens the approval inbox for one of the account's own locations: a normal 30-day inbox session (FR-13), tied to
// the account so a password reset ends it. The location must belong to the session's business.
export async function openInbox(
  session: AccountSession,
  locationId: string,
  opts: { now?: Date } = {},
  db: Db = defaultDb,
) {
  const now = opts.now ?? new Date();
  const [loc] = await db
    .select({ id: locations.id, email: ownerAccounts.normalizedEmail })
    .from(locations)
    .innerJoin(ownerAccounts, eq(ownerAccounts.businessId, locations.businessId))
    .where(and(eq(locations.id, locationId), eq(ownerAccounts.id, session.accountId)));
  if (!loc) return null;
  const secret = newSecret();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const [row] = await db
    .insert(ownerSessions)
    .values({
      locationId,
      ownerEmail: loc.email,
      // No emailed link for this session: the login token is a random value that is never sent and already expired.
      loginTokenHash: sha256(newSecret()),
      tokenExpiresAt: now,
      sessionTokenHash: sha256(secret),
      sessionExpiresAt: expiresAt,
      accountId: session.accountId,
    })
    .returning({ id: ownerSessions.id });
  await db.insert(auditLog).values({
    locationId,
    entity: "owner_session",
    entityId: row.id,
    action: "signed_in",
    actor: `owner_account:${session.accountId}`,
  });
  return { secret, expiresAt };
}
