// Operator alerts (SPEC Reliability: "Alerts go to the operator when a send fails, a Google token expires, or the
// review check has not run in 3 hours"). One email to OPERATOR_EMAIL per run, covering every new problem:
// - review_check_stale: a location connected to Google whose last successful review check (a reviews_polled audit
//   row, src/reviews/poll.ts) is 3 hours old or more, or that has never been checked. This also catches the whole
//   reviews job not running or failing (missing settings, Google down, a bad GOOGLE_TOKEN_SECRET).
// - google_token_expired: a location whose Google token the poller marked refresh_failed (Google said our access was
//   revoked or expired). That location is no longer checked until the owner reconnects, so it is not also reported
//   as stale.
// - send_failed: review requests and reminders recorded as failed (src/requests/requests.ts) since the last alert.
//
// Each problem is reported once: a stale check once per stretch without a successful check, an expired token once
// per failure, and each failed send once. The alert is recorded in the audit log in the same transaction as the send,
// under one advisory lock; the email carries a provider idempotency key built from what it reports, so a retry after
// a crash between the send and the commit is not sent twice (Resend keeps keys for 24 hours).
//
// What the email carries: business and location names and IDs, times, counts, channels and error codes. Never phone
// numbers, email addresses, names of customers or reviewers, message text or review text. Nothing here is logged.
//
// Limits: the alert runs on the same scheduler and queue as the jobs it watches, so if the scheduler itself stops,
// no alert goes out; an outside uptime check would cover that. Only review-request sends are watched here; owner
// emails (digest, low-rating, report) and the opt-out confirmation text have no failure record yet.
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, isNotNull, isNull, like, lte, ne, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { auditLog, businesses, locations, oauthTokens } from "../db/schema";
import type { EmailMessage, EmailProvider } from "../email/provider";
import { escapeHtml as e } from "../inbox/auth";

export const REVIEW_CHECK_STALE_MS = 3 * 60 * 60 * 1000;
// Failed-send rows this recent are left for the next run, so a row committed late with an earlier `at` is not missed.
export const SEND_FAILURE_SETTLE_MS = 2 * 60 * 1000;
// On the first run (no earlier send-failure alert), look back this far, not over all history.
export const SEND_FAILURE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LISTED_IDS = 20; // request IDs listed per location; counts cover the rest
const ACTOR = "system:operator_alert";
const SENT = "operator_alert_sent";

export type OperatorAlertDeps = { email: EmailProvider; operatorEmail: string; now?: Date };
export type OperatorAlertResult = {
  sent: number;
  failed: number;
  staleChecks: number;
  expiredTokens: number;
  failedSends: number;
};

export function operatorEmailFromEnv(env: Record<string, string | undefined> = process.env) {
  const v = env.OPERATOR_EMAIL?.trim();
  if (!v || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(v))
    throw new Error("OPERATOR_EMAIL missing or not an email address");
  return v;
}

type Place = { locationId: string; locationName: string; businessName: string };
export type StaleCheck = Place & { lastCheckedAt: Date | null };
export type ExpiredToken = Place & { tokenId: string; failedAt: Date | null };
export type FailedSends = Place & { requestIds: string[]; byKind: Record<string, number> };
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Q = Db | Tx;
export type Alerts = {
  stale: StaleCheck[];
  expired: ExpiredToken[];
  failures: FailedSends[];
  failuresThrough: Date | null;
};

const iso = (d: Date | null) => (d ? d.toISOString() : "never");
const toDate = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));

// The audit row that records one reported problem. Its detail is the problem's key: kind plus what dates it.
const staleKey = (a: StaleCheck) => `kind=review_check_stale;since=${iso(a.lastCheckedAt)}`;
const expiredKey = (a: ExpiredToken) => `kind=google_token_expired;since=${iso(a.failedAt)}`;
const failuresKey = (through: Date) => `kind=send_failed;through=${through.toISOString()}`;

async function alreadySent(db: Q, entity: string, entityId: string, detail: string) {
  const [row] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entity, entity),
        eq(auditLog.entityId, entityId),
        eq(auditLog.action, SENT),
        eq(auditLog.detail, detail),
      ),
    )
    .limit(1);
  return !!row;
}

// Everything not yet reported. Exported for tests; sendOperatorAlerts calls it under its lock.
export async function collectAlerts(now: Date, db: Q): Promise<Alerts> {
  // Locations the poller checks (same filter as pollReviews): a Google location, an active unrevoked token, and a
  // business that is not offboarded.
  const lastPolled = sql<Date | null>`(select max(${auditLog.at}) from ${auditLog} where ${auditLog.locationId} = ${locations.id} and ${auditLog.entity} = 'location' and ${auditLog.entityId} = ${locations.id} and ${auditLog.action} = 'reviews_polled')`;
  const connected = await db
    .select({
      locationId: locations.id,
      locationName: locations.name,
      businessName: businesses.name,
      connectedAt: locations.googleConnectedAt,
      lastPolled,
    })
    .from(locations)
    .innerJoin(businesses, eq(businesses.id, locations.businessId))
    .innerJoin(oauthTokens, eq(oauthTokens.locationId, locations.id))
    .where(
      and(
        isNotNull(locations.googleLocationId),
        eq(oauthTokens.status, "active"),
        isNull(oauthTokens.revokedAt),
        ne(businesses.status, "offboarded"),
      ),
    )
    .orderBy(asc(locations.id));
  const staleBefore = now.getTime() - REVIEW_CHECK_STALE_MS;
  const stale: StaleCheck[] = [];
  for (const c of connected) {
    const lastCheckedAt = toDate(c.lastPolled);
    // Never checked: dated from when Google was connected, so a location connected minutes ago is not reported.
    const since = lastCheckedAt ?? c.connectedAt;
    if (since && since.getTime() > staleBefore) continue;
    const a = { locationId: c.locationId, locationName: c.locationName, businessName: c.businessName, lastCheckedAt };
    if (!(await alreadySent(db, "location", c.locationId, staleKey(a)))) stale.push(a);
  }

  // Tokens the poller gave up on. An operator revoke (status revoked) is deliberate and not reported.
  const lastRevoked = sql<Date | null>`(select max(${auditLog.at}) from ${auditLog} where ${auditLog.locationId} = ${locations.id} and ${auditLog.action} = 'review_poll_failed' and ${auditLog.detail} = 'code=token_revoked')`;
  const failedTokens = await db
    .select({
      tokenId: oauthTokens.id,
      locationId: locations.id,
      locationName: locations.name,
      businessName: businesses.name,
      lastRevoked,
    })
    .from(oauthTokens)
    .innerJoin(locations, eq(locations.id, oauthTokens.locationId))
    .innerJoin(businesses, eq(businesses.id, locations.businessId))
    .where(and(eq(oauthTokens.status, "refresh_failed"), ne(businesses.status, "offboarded")))
    .orderBy(asc(locations.id));
  const expired: ExpiredToken[] = [];
  for (const t of failedTokens) {
    const { lastRevoked: at, ...rest } = t;
    const a = { ...rest, failedAt: toDate(at) };
    if (!(await alreadySent(db, "oauth_token", t.tokenId, expiredKey(a)))) expired.push(a);
  }

  // Failed sends after the last send-failure alert (its `through` time), up to a little before now.
  const [prev] = await db
    .select({ detail: auditLog.detail })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entity, "operator_alert"),
        eq(auditLog.action, SENT),
        like(auditLog.detail, "kind=send_failed;%"),
      ),
    )
    .orderBy(desc(auditLog.at))
    .limit(1);
  const prevThrough = toDate(prev?.detail?.match(/through=([^;]+)/)?.[1] ?? null);
  const lookback = new Date(now.getTime() - SEND_FAILURE_LOOKBACK_MS);
  const from = prevThrough && prevThrough > lookback ? prevThrough : lookback;
  const through = new Date(now.getTime() - SEND_FAILURE_SETTLE_MS);
  const failures: FailedSends[] = [];
  if (through > from) {
    const rows = await db
      .select({
        requestId: auditLog.entityId,
        detail: auditLog.detail,
        locationId: locations.id,
        locationName: locations.name,
        businessName: businesses.name,
      })
      .from(auditLog)
      .innerJoin(locations, eq(locations.id, auditLog.locationId))
      .innerJoin(businesses, eq(businesses.id, locations.businessId))
      .where(
        and(
          eq(auditLog.entity, "review_request"),
          eq(auditLog.action, "failed"),
          gt(auditLog.at, from),
          lte(auditLog.at, through),
        ),
      )
      .orderBy(asc(locations.id), asc(auditLog.at));
    const byLocation = new Map<string, FailedSends>();
    for (const r of rows) {
      let f = byLocation.get(r.locationId);
      if (!f) {
        f = {
          locationId: r.locationId,
          locationName: r.locationName,
          businessName: r.businessName,
          requestIds: [],
          byKind: {},
        };
        byLocation.set(r.locationId, f);
        failures.push(f);
      }
      const channel = r.detail?.match(/channel=([a-z]+)/)?.[1] ?? "unknown";
      const error = r.detail?.match(/error=([a-z0-9_]+)/)?.[1] ?? "unknown";
      const kind = `${channel} ${error}`;
      f.byKind[kind] = (f.byKind[kind] ?? 0) + 1;
      if (r.requestId) f.requestIds.push(r.requestId);
    }
  }
  // The watermark moves only when failures are reported, so quiet runs write nothing.
  return { stale, expired, failures, failuresThrough: failures.length ? through : null };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const place = (p: Place) => `${p.businessName} (${p.locationName}, location ${p.locationId})`;
const hoursAgo = (d: Date, now: Date) => Math.floor((now.getTime() - d.getTime()) / (60 * 60 * 1000));

export function alertEmail(alerts: Alerts, operatorEmail: string, now: Date): EmailMessage {
  const sendCount = alerts.failures.reduce((n, f) => n + Object.values(f.byKind).reduce((a, b) => a + b, 0), 0);
  const summary = [
    sendCount && plural(sendCount, "failed send"),
    alerts.expired.length && plural(alerts.expired.length, "Google connection") + " expired",
    alerts.stale.length && plural(alerts.stale.length, "review check") + " not run in 3 hours",
  ].filter(Boolean);

  const sections: { title: string; lines: string[]; note: string }[] = [];
  if (alerts.failures.length)
    sections.push({
      title: "Failed sends",
      lines: alerts.failures.map((f) => {
        const kinds = Object.entries(f.byKind)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, n]) => `${k} x${n}`)
          .join(", ");
        const ids = f.requestIds.slice(0, MAX_LISTED_IDS).join(", ");
        const more = f.requestIds.length > MAX_LISTED_IDS ? ` and ${f.requestIds.length - MAX_LISTED_IDS} more` : "";
        return `${place(f)}: ${kinds}. Request IDs: ${ids}${more}.`;
      }),
      note: "A failed text goes out by email when the customer has an email address. A send whose outcome is unknown is never retried.",
    });
  if (alerts.expired.length)
    sections.push({
      title: "Google connection expired",
      lines: alerts.expired.map(
        (t) => `${place(t)}: Google refused our access${t.failedAt ? ` at ${iso(t.failedAt)}` : ""}.`,
      ),
      note: "Reviews for these locations are not being checked. The owner needs to connect Google again.",
    });
  if (alerts.stale.length)
    sections.push({
      title: "Review check not run in 3 hours",
      lines: alerts.stale.map((s) =>
        s.lastCheckedAt
          ? `${place(s)}: last successful check ${iso(s.lastCheckedAt)} (${hoursAgo(s.lastCheckedAt, now)} hours ago).`
          : `${place(s)}: never checked successfully.`,
      ),
      note: "Look at the reviews job's log for missing settings or Google errors. Each location is reported once until a check succeeds again.",
    });

  const head = `Kindword needs your attention: ${summary.join(", ")}.`;
  const foot = "Each problem is reported once. The audit log has the details.";
  const text = [
    head,
    ...sections.flatMap((s) => ["", `${s.title}:`, ...s.lines.map((l) => `- ${l}`), s.note]),
    "",
    foot,
  ].join("\n");
  const html = `<p>${e(head)}</p>${sections
    .map((s) => `<h2>${e(s.title)}</h2><ul>${s.lines.map((l) => `<li>${e(l)}</li>`).join("")}</ul><p>${e(s.note)}</p>`)
    .join("")}<p>${e(foot)}</p>`;
  const keys = [
    ...alerts.stale.map((a) => `${a.locationId}/${staleKey(a)}`),
    ...alerts.expired.map((a) => `${a.tokenId}/${expiredKey(a)}`),
    ...alerts.failures.flatMap((f) => f.requestIds),
  ].sort();
  return {
    to: operatorEmail,
    fromName: "Kindword",
    subject: `Kindword alert: ${summary.join(", ")}`,
    text,
    html,
    headers: {},
    idempotencyKey: `operator-alert/${createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 32)}`,
  };
}

class AlertSendError extends Error {}

export async function sendOperatorAlerts(deps: OperatorAlertDeps, db: Db = defaultDb): Promise<OperatorAlertResult> {
  const now = deps.now ?? new Date();
  const result: OperatorAlertResult = { sent: 0, failed: 0, staleChecks: 0, expiredTokens: 0, failedSends: 0 };
  try {
    await db.transaction(async (tx) => {
      // One alert run at a time, so two overlapping runs never report the same problem twice.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('operator-alerts'))`);
      const alerts = await collectAlerts(now, tx);
      const failedSends = alerts.failures.reduce((n, f) => n + Object.values(f.byKind).reduce((a, b) => a + b, 0), 0);
      Object.assign(result, { staleChecks: alerts.stale.length, expiredTokens: alerts.expired.length, failedSends });
      const rows: (typeof auditLog.$inferInsert)[] = [
        ...alerts.stale.map((a) => ({
          locationId: a.locationId,
          entity: "location",
          entityId: a.locationId,
          action: SENT,
          actor: ACTOR,
          detail: staleKey(a),
        })),
        ...alerts.expired.map((a) => ({
          locationId: a.locationId,
          entity: "oauth_token",
          entityId: a.tokenId,
          action: SENT,
          actor: ACTOR,
          detail: expiredKey(a),
        })),
      ];
      if (alerts.failuresThrough)
        rows.push({
          entity: "operator_alert",
          action: SENT,
          actor: ACTOR,
          detail: `${failuresKey(alerts.failuresThrough)};count=${failedSends}`,
        });
      if (!rows.length) return;
      try {
        await deps.email.send(alertEmail(alerts, deps.operatorEmail, now));
      } catch {
        throw new AlertSendError(); // rolls back: nothing is recorded as reported
      }
      await tx.insert(auditLog).values(rows.map((r) => ({ ...r, at: now })));
      result.sent = 1;
    });
  } catch (err) {
    if (!(err instanceof AlertSendError)) throw err; // a database error: the job fails and the queue retries it
    // The provider refused or timed out: the next run reports the same problems under the same idempotency key.
    // No details logged (they may echo the address).
    result.sent = 0;
    result.failed = 1;
  }
  return result;
}
