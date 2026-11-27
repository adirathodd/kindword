// Operator alerts (SPEC Reliability: "Alerts go to the operator when a send fails, a Google token expires, or the
// review check has not run in 3 hours"; Week 4 gate: "alerts fire on a forced failure"). One email to OPERATOR_EMAIL
// per run, only when something new needs the operator:
// - send_failed: a review request or reminder that failed (audit action "failed" on a review_request, written by
//   src/requests/requests.ts), each failure alerted once. Grouped per location by channel and error code
//   (provider_rejected, outcome_unknown, provider_opted_out).
// - token_expired: a location's Google token marked refresh_failed by review polling (Google answered invalid_grant).
//   Alerted once per failure: a later reconnect and a new failure alert again.
// - review_check_stale: a connected location whose reviews have not been read successfully for 3 hours (since its
//   last successful poll, or since google_connected_at when it has never been polled). This catches a review job that
//   stopped running, lost a setting, or keeps failing for one location. Alerted once per stale period: the next
//   successful poll ends it.
// - owner_email_failed: an owner email (daily digest, low-rating email, monthly report) that failed (audit action
//   "owner_email_failed", written by src/notifications/sendFailures.ts). Owner emails are retried on every run, so a
//   lasting failure fails many times: each location, kind and period (the digest's day, the low-rating email's UTC
//   day, the report's month) is alerted once, with the number of failed attempts and their error codes.
// - opt_out_confirmation_failed: the one confirmation text after an opt-out was not confirmed sent within the 5-minute
//   window, so the optout-confirmations job gave up on it (optout_confirmations.status "expired", src/optout/
//   confirmations.ts). Each such row is alerted once. The opt-out itself is already recorded and honored.
// Offboarded businesses are left out: nothing sends or polls for them.
//
// What the email carries: business and location names and IDs, counts, channels and error codes. Never phone
// numbers, email addresses, message text, review text or reviewer names (SPEC hard constraints, FR-19).
//
// Idempotent (SPEC Reliability): the run holds one advisory lock, re-reads what is unalerted, sends with a provider
// idempotency key built from exactly those alerts, and records one audit row per alert in the same transaction. A
// failed send records nothing, so the next run tries again under the same key; a crash between send and commit is
// caught by the key (Resend keeps keys for 24 hours).
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, max, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db as defaultDb, type Db } from "../db/client";
import { auditLog, businesses, locations, oauthTokens, optOutConfirmations } from "../db/schema";
import type { EmailMessage, EmailProvider } from "../email/provider";
import { escapeHtml as e } from "../inbox/auth";
import { FAILURE_ACTIONS } from "./sendFailures";

export const REVIEW_CHECK_STALE_MS = 3 * 60 * 60 * 1000; // "the review check has not run in 3 hours"
const ACTOR = "system:operator_alert";
export const ALERT_ACTIONS = {
  send_failed: "operator_alert_send_failed",
  token_expired: "operator_alert_token_expired",
  review_check_stale: "operator_alert_review_check_stale",
  owner_email_failed: "operator_alert_owner_email_failed",
  confirmation_failed: "operator_alert_opt_out_confirmation_failed",
} as const;

export type OperatorAlertDeps = { email: EmailProvider; operatorEmail: string; now?: Date };
export type OperatorAlertResult = {
  sent: number; // 0 or 1: one email per run
  sendFailed: number;
  tokenExpired: number;
  reviewCheckStale: number;
  ownerEmailFailed: number;
  confirmationFailed: number;
};

type Place = { locationId: string | null; locationName: string | null; businessName: string | null };
export type SendFailure = Place & { auditId: string; requestId: string; channel: string; error: string };
export type TokenExpiry = Place & { tokenId: string; since: Date | null };
export type StaleCheck = Place & { lastPolledAt: Date | null; since: Date };
// One location, kind and period; attempts counts every failed try not yet alerted, errors their distinct codes.
export type OwnerEmailFailure = Place & { kind: string; period: string; attempts: number; errors: string[] };
export type ConfirmationFailure = Place & { confirmationId: string; attempts: number };
export type Alerts = {
  sendFailed: SendFailure[];
  tokenExpired: TokenExpiry[];
  reviewCheckStale: StaleCheck[];
  ownerEmailFailed: OwnerEmailFailure[];
  confirmationFailed: ConfirmationFailure[];
};

type Q = Pick<Db, "select">;
const field = (detail: string | null, key: string) =>
  detail
    ?.split(";")
    .find((p) => p.startsWith(`${key}=`))
    ?.slice(key.length + 1) ?? "unknown";

// Failed review-request sends not yet alerted. Read from the audit log, so a failure is still reported after its
// customer row was deleted; the location may be gone too (names then show as unknown).
async function sendFailures(q: Q): Promise<SendFailure[]> {
  const alerted = alias(auditLog, "alerted");
  const rows = await q
    .select({
      auditId: auditLog.id,
      requestId: auditLog.entityId,
      detail: auditLog.detail,
      locationId: auditLog.locationId,
      locationName: locations.name,
      businessName: businesses.name,
      status: businesses.status,
    })
    .from(auditLog)
    .leftJoin(locations, eq(locations.id, auditLog.locationId))
    .leftJoin(businesses, eq(businesses.id, locations.businessId))
    .where(
      and(
        eq(auditLog.entity, "review_request"),
        eq(auditLog.action, "failed"),
        isNotNull(auditLog.entityId),
        or(isNull(businesses.status), ne(businesses.status, "offboarded")),
        notExists(
          q
            .select({ x: sql`1` })
            .from(alerted)
            .where(
              and(
                eq(alerted.entity, "review_request"),
                eq(alerted.entityId, auditLog.entityId),
                eq(alerted.action, ALERT_ACTIONS.send_failed),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(auditLog.at), asc(auditLog.id));
  return rows.map((r) => ({
    auditId: r.auditId,
    requestId: r.requestId!,
    channel: field(r.detail, "channel"),
    error: field(r.detail, "error"),
    locationId: r.locationId,
    locationName: r.locationName,
    businessName: r.businessName,
  }));
}

// Google tokens that polling marked refresh_failed and that have no alert since their latest token_revoked failure.
async function tokenExpiries(q: Q): Promise<TokenExpiry[]> {
  const rows = await q
    .select({
      tokenId: oauthTokens.id,
      locationId: locations.id,
      locationName: locations.name,
      businessName: businesses.name,
    })
    .from(oauthTokens)
    .innerJoin(locations, eq(locations.id, oauthTokens.locationId))
    .innerJoin(businesses, eq(businesses.id, locations.businessId))
    .where(
      and(eq(oauthTokens.status, "refresh_failed"), isNull(oauthTokens.revokedAt), ne(businesses.status, "offboarded")),
    )
    .orderBy(asc(locations.id));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.locationId);
  const tokenIds = rows.map((r) => r.tokenId);
  const failedAt = new Map(
    (
      await q
        .select({ locationId: auditLog.locationId, at: max(auditLog.at) })
        .from(auditLog)
        .where(
          and(
            inArray(auditLog.locationId, ids),
            eq(auditLog.action, "review_poll_failed"),
            eq(auditLog.detail, "code=token_revoked"),
          ),
        )
        .groupBy(auditLog.locationId)
    ).map((r) => [r.locationId, r.at]),
  );
  const alertedAt = new Map(
    (
      await q
        .select({ tokenId: auditLog.entityId, at: max(auditLog.at) })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.entity, "oauth_token"),
            inArray(auditLog.entityId, tokenIds),
            eq(auditLog.action, ALERT_ACTIONS.token_expired),
          ),
        )
        .groupBy(auditLog.entityId)
    ).map((r) => [r.tokenId, r.at]),
  );
  return rows.flatMap((r) => {
    const since = failedAt.get(r.locationId) ?? null;
    const last = alertedAt.get(r.tokenId);
    // Already alerted for this failure (or, with no failure on record, alerted at all).
    if (last && (!since || last >= since)) return [];
    return [{ ...r, since }];
  });
}

// Connected locations (the same ones review polling reads) with no successful read for REVIEW_CHECK_STALE_MS, and
// no alert yet for this stale period.
async function staleChecks(q: Q, now: Date): Promise<StaleCheck[]> {
  const rows = await q
    .select({
      locationId: locations.id,
      locationName: locations.name,
      businessName: businesses.name,
      connectedAt: locations.googleConnectedAt,
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
  if (!rows.length) return [];
  const ids = rows.map((r) => r.locationId);
  const latest = async (action: string) =>
    new Map(
      (
        await q
          .select({ locationId: auditLog.locationId, at: max(auditLog.at) })
          .from(auditLog)
          .where(
            and(
              inArray(auditLog.locationId, ids),
              eq(auditLog.entity, "location"),
              inArray(auditLog.entityId, ids),
              eq(auditLog.action, action),
            ),
          )
          .groupBy(auditLog.locationId)
      ).map((r) => [r.locationId, r.at]),
    );
  const polled = await latest("reviews_polled");
  const alerted = await latest(ALERT_ACTIONS.review_check_stale);
  return rows.flatMap((r) => {
    const lastPolledAt = polled.get(r.locationId) ?? null;
    // A location never read and with no connection time counts from the epoch: it has never been checked.
    const since = [lastPolledAt, r.connectedAt].reduce<Date>((a, b) => (b && b > a ? b : a), new Date(0));
    if (now.getTime() - since.getTime() < REVIEW_CHECK_STALE_MS) return [];
    const last = alerted.get(r.locationId);
    if (last && last > since) return []; // already alerted for this stale period
    const place = { locationId: r.locationId, locationName: r.locationName, businessName: r.businessName };
    return [{ ...place, lastPolledAt, since }];
  });
}

// Owner email failures whose location, kind and period has no alert yet. The alert row's detail is the failure
// row's "kind=…;period=…" prefix, so later failures for an alerted period are left out.
async function ownerEmailFailures(q: Q): Promise<OwnerEmailFailure[]> {
  const alerted = alias(auditLog, "alerted");
  const rows = await q
    .select({
      detail: auditLog.detail,
      locationId: auditLog.locationId,
      locationName: locations.name,
      businessName: businesses.name,
    })
    .from(auditLog)
    .leftJoin(locations, eq(locations.id, auditLog.locationId))
    .leftJoin(businesses, eq(businesses.id, locations.businessId))
    .where(
      and(
        eq(auditLog.entity, "location"),
        eq(auditLog.action, FAILURE_ACTIONS.owner_email),
        isNotNull(auditLog.locationId),
        or(isNull(businesses.status), ne(businesses.status, "offboarded")),
        notExists(
          q
            .select({ x: sql`1` })
            .from(alerted)
            .where(
              and(
                eq(alerted.locationId, auditLog.locationId),
                eq(alerted.action, ALERT_ACTIONS.owner_email_failed),
                sql`starts_with(${auditLog.detail}, ${alerted.detail} || ';')`,
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(auditLog.at), asc(auditLog.id));
  const groups = new Map<string, OwnerEmailFailure>();
  for (const r of rows) {
    const kind = field(r.detail, "kind");
    const period = field(r.detail, "period");
    const key = `${r.locationId}|${kind}|${period}`;
    const g = groups.get(key) ?? {
      locationId: r.locationId,
      locationName: r.locationName,
      businessName: r.businessName,
      kind,
      period,
      attempts: 0,
      errors: [],
    };
    g.attempts++;
    const error = field(r.detail, "error");
    if (!g.errors.includes(error)) g.errors.push(error);
    groups.set(key, g);
  }
  return [...groups.values()];
}

// Opt-out confirmations the job gave up on (expired: not confirmed sent within 5 minutes) with no alert yet. The
// alert row's entity_id is the confirmation row's id.
async function confirmationFailures(q: Q): Promise<ConfirmationFailure[]> {
  const c = optOutConfirmations;
  const rows = await q
    .select({
      confirmationId: c.id,
      attempts: c.attempts,
      locationId: c.locationId,
      locationName: locations.name,
      businessName: businesses.name,
    })
    .from(c)
    .leftJoin(locations, eq(locations.id, c.locationId))
    .leftJoin(businesses, eq(businesses.id, locations.businessId))
    .where(
      and(
        eq(c.status, "expired"),
        or(isNull(businesses.status), ne(businesses.status, "offboarded")),
        notExists(
          q
            .select({ x: sql`1` })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.entity, "optout_confirmation"),
                eq(auditLog.entityId, c.id),
                eq(auditLog.action, ALERT_ACTIONS.confirmation_failed),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(c.createdAt), asc(c.id));
  return rows;
}

export async function findAlerts(now: Date, q: Q = defaultDb): Promise<Alerts> {
  return {
    sendFailed: await sendFailures(q),
    tokenExpired: await tokenExpiries(q),
    reviewCheckStale: await staleChecks(q, now),
    ownerEmailFailed: await ownerEmailFailures(q),
    confirmationFailed: await confirmationFailures(q),
  };
}

const total = (a: Alerts) =>
  a.sendFailed.length +
  a.tokenExpired.length +
  a.reviewCheckStale.length +
  a.ownerEmailFailed.length +
  a.confirmationFailed.length;
const where = (p: Place) =>
  p.locationId
    ? `${p.businessName ?? "Unknown business"} (${p.locationName ?? "unknown location"}, location ${p.locationId})`
    : "No location on record";
const hours = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / (60 * 60 * 1000));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ERROR_LABEL: Record<string, string> = {
  provider_rejected: "refused by the provider",
  outcome_unknown: "outcome unknown (may have reached the customer; no more retries)",
  provider_opted_out: "customer had opted out at the provider (now suppressed)",
  carrier_undelivered: "accepted, then reported undelivered by the carrier (sent by email instead when possible)",
};

const OWNER_EMAIL_LABEL: Record<string, string> = {
  digest: "daily digest",
  low_rating: "low-rating email",
  monthly_report: "monthly report",
};

// Lines for the email, grouped and counted; no personal data.
export function alertLines(a: Alerts, now: Date) {
  const sections: { title: string; items: string[] }[] = [];
  if (a.sendFailed.length) {
    const groups = new Map<string, { place: Place; counts: Map<string, number> }>();
    for (const f of a.sendFailed) {
      const key = f.locationId ?? "";
      const g = groups.get(key) ?? { place: f, counts: new Map() };
      const label = `${f.channel === "sms" ? "text" : f.channel}, ${ERROR_LABEL[f.error] ?? f.error}`;
      g.counts.set(label, (g.counts.get(label) ?? 0) + 1);
      groups.set(key, g);
    }
    sections.push({
      title: `${plural(a.sendFailed.length, "review request send")} failed`,
      items: [...groups.values()].map(
        (g) => `${where(g.place)}: ${[...g.counts].map(([label, n]) => `${plural(n, "send")} (${label})`).join("; ")}`,
      ),
    });
  }
  if (a.tokenExpired.length)
    sections.push({
      title: `Google access stopped working for ${plural(a.tokenExpired.length, "location")}`,
      items: a.tokenExpired.map(
        (t) =>
          `${where(t)}: Google refused the saved access${t.since ? ` at ${t.since.toISOString()}` : ""}. Reviews are not read until the owner connects Google again.`,
      ),
    });
  if (a.reviewCheckStale.length)
    sections.push({
      title: `Review check has not run in 3 hours for ${plural(a.reviewCheckStale.length, "location")}`,
      items: a.reviewCheckStale.map(
        (s) =>
          `${where(s)}: ${
            s.lastPolledAt
              ? `last successful check ${hours(s.lastPolledAt, now)} hours ago (${s.lastPolledAt.toISOString()})`
              : "never checked successfully"
          }. Check the reviews job log and the Google settings.`,
      ),
    });
  if (a.ownerEmailFailed.length)
    sections.push({
      title: `${plural(a.ownerEmailFailed.length, "owner email")} failed`,
      items: a.ownerEmailFailed.map(
        (f) =>
          `${where(f)}: ${OWNER_EMAIL_LABEL[f.kind] ?? f.kind} for ${f.period}, ${plural(f.attempts, "failed attempt")} (${f.errors.join(", ")}). Retried on every run; later failures for the same ${f.kind === "monthly_report" ? "month" : "day"} are not reported again.`,
      ),
    });
  if (a.confirmationFailed.length)
    sections.push({
      title: `${plural(a.confirmationFailed.length, "opt-out confirmation text")} failed`,
      items: a.confirmationFailed.map(
        (c) =>
          `${where(c)}: confirmation not confirmed sent within 5 minutes (${plural(c.attempts, "attempt")}). The opt-out is recorded and honored; nothing more is sent to that number.`,
      ),
    });
  return sections;
}

export function operatorAlertEmail(a: Alerts, to: string, now: Date): EmailMessage {
  const sections = alertLines(a, now);
  const n = total(a);
  const head = `${plural(n, "new problem")} for Kindword at ${now.toISOString()}.`;
  const foot = "Each problem is reported once. Details are in the audit log and the job logs.";
  const text = [head, ...sections.flatMap((s) => ["", `${s.title}:`, ...s.items.map((i) => `- ${i}`)]), "", foot].join(
    "\n",
  );
  const html = `<p>${e(head)}</p>${sections
    .map((s) => `<p>${e(s.title)}:</p><ul>${s.items.map((i) => `<li>${e(i)}</li>`).join("")}</ul>`)
    .join("")}<p>${e(foot)}</p>`;
  // Stable for exactly this set of alerts, so a retried send is not delivered twice.
  const keys = [
    ...a.sendFailed.map((f) => `f:${f.requestId}`),
    ...a.tokenExpired.map((t) => `t:${t.tokenId}:${t.since?.toISOString() ?? ""}`),
    ...a.reviewCheckStale.map((s) => `s:${s.locationId}:${s.since.toISOString()}`),
    ...a.ownerEmailFailed.map((f) => `o:${f.locationId}:${f.kind}:${f.period}`),
    ...a.confirmationFailed.map((c) => `c:${c.confirmationId}`),
  ].sort();
  return {
    to,
    fromName: "Kindword",
    subject: `Kindword alert: ${sections.map((s) => s.title).join("; ")}`.slice(0, 200),
    text,
    html,
    headers: {},
    idempotencyKey: `operator-alert/${createHash("sha256").update(keys.join("\n")).digest("hex")}`,
  };
}

// Checks for new problems and emails the operator once about them. Run every 15 minutes, on its own schedule so a
// stopped or misconfigured review job is still noticed.
export async function sendOperatorAlerts(deps: OperatorAlertDeps, db: Db = defaultDb): Promise<OperatorAlertResult> {
  const now = deps.now ?? new Date();
  const empty = {
    sent: 0,
    sendFailed: 0,
    tokenExpired: 0,
    reviewCheckStale: 0,
    ownerEmailFailed: 0,
    confirmationFailed: 0,
  };
  if (!total(await findAlerts(now, db))) return empty;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('operator-alerts'))`);
    const a = await findAlerts(now, tx); // re-read under the lock: a concurrent run may have sent them
    if (!total(a)) return empty;
    await deps.email.send(operatorAlertEmail(a, deps.operatorEmail, now)); // throws: nothing recorded, retried
    const row = (
      locationId: string | null,
      entity: string,
      entityId: string | null,
      action: string,
      detail: string,
    ) => ({
      locationId,
      entity,
      entityId,
      action,
      actor: ACTOR,
      detail,
      at: now,
    });
    await tx
      .insert(auditLog)
      .values([
        ...a.sendFailed.map((f) =>
          row(f.locationId, "review_request", f.requestId, ALERT_ACTIONS.send_failed, `error=${f.error}`),
        ),
        ...a.tokenExpired.map((t) =>
          row(t.locationId, "oauth_token", t.tokenId, ALERT_ACTIONS.token_expired, "code=token_revoked"),
        ),
        ...a.reviewCheckStale.map((s) =>
          row(s.locationId, "location", s.locationId!, ALERT_ACTIONS.review_check_stale, "hours=3"),
        ),
        ...a.ownerEmailFailed.map((f) =>
          row(
            f.locationId,
            "location",
            f.locationId,
            ALERT_ACTIONS.owner_email_failed,
            `kind=${f.kind};period=${f.period}`,
          ),
        ),
        ...a.confirmationFailed.map((c) =>
          row(
            c.locationId,
            "optout_confirmation",
            c.confirmationId,
            ALERT_ACTIONS.confirmation_failed,
            `attempts=${c.attempts}`,
          ),
        ),
      ]);
    return {
      sent: 1,
      sendFailed: a.sendFailed.length,
      tokenExpired: a.tokenExpired.length,
      reviewCheckStale: a.reviewCheckStale.length,
      ownerEmailFailed: a.ownerEmailFailed.length,
      confirmationFailed: a.confirmationFailed.length,
    };
  });
}
