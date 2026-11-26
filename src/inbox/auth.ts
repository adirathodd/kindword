// Owner passwordless sign-in (SPEC FR-13; Security: owner sign-in links). A sign-in link is single use, bound to one
// location, expires in 15 minutes, and only its SHA-256 hash is stored. Using it starts a 30-day session for that
// location only; the session credential is a fresh random secret (also stored only as a hash), never the emailed
// token. The operator can revoke every session and unused link for a location.
// Audit rows carry IDs only, never the owner's email address or any token.
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { auditLog, businesses, locations, ownerSessions } from "../db/schema";
import type { EmailProvider } from "../email/provider";

const MINUTE = 60 * 1000;
export const LINK_TTL_MS = 15 * MINUTE;
export const SESSION_TTL_MS = 30 * 24 * 60 * MINUTE;

// Shared by every sign-in kind (owner link, owner account, operator): a 256-bit random secret, and the SHA-256 hex
// that is all the database keeps of it.
export const newSecret = () => randomBytes(32).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
// Tokens and session secrets are 32 random bytes in base64url (43 chars); anything else cannot be ours.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const looksLikeSecret = (s: string | undefined | null): s is string => !!s && /^[A-Za-z0-9_-]{43}$/.test(s);

export type OwnerSession = { sessionId: string; locationId: string };

export class NoOwnerEmailError extends Error {
  constructor() {
    super("The location's business has no owner email on file");
    this.name = "NoOwnerEmailError";
  }
}

export function inboxBaseUrl(env: Record<string, string | undefined> = process.env) {
  const baseUrl = env.APP_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl || !/^https?:\/\//.test(baseUrl) || !URL.canParse(baseUrl))
    throw new Error("APP_BASE_URL missing or not an http(s) URL");
  return baseUrl;
}

// Creates a sign-in link for the location's owner (the business's owner_email). Returns the URL to send; only its
// hash is kept. Each call creates a new link; older unused links stay valid until they expire. With accountId (the
// owner's account, FR-24) the session it starts is tied to that account, so a password reset ends it.
export async function createSignInLink(
  locationId: string,
  opts: { baseUrl: string; now?: Date; accountId?: string },
  db: Db = defaultDb,
): Promise<{ url: string; ownerEmail: string; businessName: string; locationName: string; expiresAt: Date }> {
  const now = opts.now ?? new Date();
  const [loc] = await db
    .select({ ownerEmail: businesses.ownerEmail, businessName: businesses.name, locationName: locations.name })
    .from(locations)
    .innerJoin(businesses, eq(businesses.id, locations.businessId))
    .where(eq(locations.id, locationId));
  if (!loc) throw new Error("Location not found");
  const ownerEmail = loc.ownerEmail?.trim().toLowerCase();
  if (!ownerEmail) throw new NoOwnerEmailError();

  const token = newSecret();
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS);
  const [row] = await db
    .insert(ownerSessions)
    .values({
      locationId,
      ownerEmail,
      loginTokenHash: sha256(token),
      tokenExpiresAt: expiresAt,
      accountId: opts.accountId,
    })
    .returning({ id: ownerSessions.id });
  await db.insert(auditLog).values({
    locationId,
    entity: "owner_session",
    entityId: row.id,
    action: "sign_in_link_created",
    actor: "system",
  });
  return {
    url: `${opts.baseUrl}/inbox/sign-in/${token}`,
    ownerEmail,
    businessName: loc.businessName,
    locationName: loc.locationName,
    expiresAt,
  };
}

// Emails the owner a fresh sign-in link (Flow 1 step 4; also how an owner gets back in after a session ends).
// A transactional message to the owner, not a review request, so it carries no unsubscribe footer.
export async function sendSignInLink(
  locationId: string,
  email: EmailProvider,
  opts: { baseUrl: string; now?: Date },
  db: Db = defaultDb,
) {
  const link = await createSignInLink(locationId, opts, db);
  const where = `${link.businessName} (${link.locationName})`;
  const text = [
    `Use this link to open the review reply inbox for ${where}:`,
    "",
    link.url,
    "",
    "The link works once and expires in 15 minutes. After you sign in, you stay signed in on this device for 30 days.",
    "If you did not expect this email, you can ignore it.",
  ].join("\n");
  const html = `<p>Use this link to open the review reply inbox for ${escapeHtml(where)}:</p><p><a href="${escapeHtml(link.url)}">Open the reply inbox</a></p><p>The link works once and expires in 15 minutes. After you sign in, you stay signed in on this device for 30 days.</p><p>If you did not expect this email, you can ignore it.</p>`;
  await email.send({
    to: link.ownerEmail,
    fromName: "Review replies",
    subject: `Sign in to your review reply inbox: ${link.businessName}`,
    text,
    html,
    headers: {},
  });
  return { expiresAt: link.expiresAt };
}

// Uses a sign-in token: succeeds once, within 15 minutes, while not revoked. Returns the new session's secret
// (for the cookie) or null. Atomic, so two concurrent clicks cannot both start a session.
export async function redeemSignInToken(
  token: string,
  opts: { now?: Date } = {},
  db: Db = defaultDb,
): Promise<{ secret: string; expiresAt: Date; session: OwnerSession } | null> {
  if (!looksLikeSecret(token)) return null;
  const now = opts.now ?? new Date();
  const secret = newSecret();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const [row] = await db
    .update(ownerSessions)
    .set({ sessionTokenHash: sha256(secret), sessionExpiresAt: expiresAt })
    .where(
      and(
        eq(ownerSessions.loginTokenHash, sha256(token)),
        isNull(ownerSessions.sessionTokenHash), // single use
        gt(ownerSessions.tokenExpiresAt, now),
        isNull(ownerSessions.revokedAt),
      ),
    )
    .returning({ id: ownerSessions.id, locationId: ownerSessions.locationId });
  if (!row) return null;
  await db.insert(auditLog).values({
    locationId: row.locationId,
    entity: "owner_session",
    entityId: row.id,
    action: "signed_in",
    actor: `owner_session:${row.id}`,
  });
  return { secret, expiresAt, session: { sessionId: row.id, locationId: row.locationId } };
}

// The session for a cookie value, or null when unknown, expired or revoked. The location comes only from here.
export async function getOwnerSession(
  secret: string | undefined | null,
  opts: { now?: Date } = {},
  db: Db = defaultDb,
): Promise<OwnerSession | null> {
  if (!looksLikeSecret(secret)) return null;
  const now = opts.now ?? new Date();
  const [row] = await db
    .select({ sessionId: ownerSessions.id, locationId: ownerSessions.locationId })
    .from(ownerSessions)
    .where(
      and(
        eq(ownerSessions.sessionTokenHash, sha256(secret)),
        gt(ownerSessions.sessionExpiresAt, now),
        isNull(ownerSessions.revokedAt),
      ),
    );
  return row ?? null;
}

export async function signOut(secret: string | undefined | null, db: Db = defaultDb) {
  if (!looksLikeSecret(secret)) return;
  const [row] = await db
    .update(ownerSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(ownerSessions.sessionTokenHash, sha256(secret)), isNull(ownerSessions.revokedAt)))
    .returning({ id: ownerSessions.id, locationId: ownerSessions.locationId });
  if (row)
    await db.insert(auditLog).values({
      locationId: row.locationId,
      entity: "owner_session",
      entityId: row.id,
      action: "signed_out",
      actor: `owner_session:${row.id}`,
    });
}

// Operator action: ends every session and unused sign-in link for the location (e.g. a leaked link, offboarding).
export async function revokeOwnerSessions(locationId: string, opts: { now?: Date } = {}, db: Db = defaultDb) {
  const now = opts.now ?? new Date();
  const rows = await db
    .update(ownerSessions)
    .set({ revokedAt: now })
    .where(
      and(
        eq(ownerSessions.locationId, locationId),
        isNull(ownerSessions.revokedAt),
        or(gt(ownerSessions.sessionExpiresAt, now), gt(ownerSessions.tokenExpiresAt, now)),
      ),
    )
    .returning({ id: ownerSessions.id });
  if (rows.length)
    await db.insert(auditLog).values(
      rows.map((r) => ({
        locationId,
        entity: "owner_session",
        entityId: r.id,
        action: "revoked",
        actor: "operator",
      })),
    );
  return rows.length;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
