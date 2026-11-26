// Monthly report email to the owner (SPEC FR-17, Flow 4). Once a month, for each location, the owner gets a summary
// of the previous calendar month in the location's time zone:
// - From a live Google fetch at generation time (only when the location has a working Google connection): new
//   reviews, their average rating and the business's response time. Computed in memory for the email only and never
//   stored (not in the database, the audit log or logs): Google content may not be kept beyond 30 days or
//   aggregated, and the SPEC keeps no rating averages or review counts from reviews (Data model; Decisions: Report
//   data).
// - From our own records: review requests and reminders sent, link clicks, opt-outs at this location, replies the
//   owner approved (and the median time to approve, from the audit log, which is not purged) and replies posted.
//   "Delivered" counts the requests and reminders sent in the month that the carrier (Twilio status callback) or
//   Resend confirmed delivered (src/requests/delivery.ts). It is left out while it is 0, which is also what a
//   deployment without delivery receipts set up would show, so a 0 never reads as "nothing arrived".
// Without a Google connection (manual-fallback mode) the report has our own figures only.
//
// The email carries no review text, reviewer names or reply text. Who gets it is the same as the daily digest
// (src/notifications/ownerEmails.ts recipients): the business's owner email, businesses not offboarded, accounts not
// disabled. A location with no activity of ours in the month and no Google connection gets no report.
//
// When: on the first run at or after DIGEST_HOUR local time on the 1st; a run missed on the 1st catches up later in
// the month. One report per location per month, idempotent like the other owner emails: a per-location advisory
// lock, an audit row (month=YYYY-MM, no figures) checked before sending and written in the same transaction, and a
// stable provider idempotency key. The hourly monthly-report job runs it (src/jobs/jobs.ts, vercel.json).
import { and, count, eq, exists, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { auditLog, locations, oauthTokens, replyDrafts, reviewRequests, suppressionList, visits } from "../db/schema";
import type { EmailMessage, EmailProvider } from "../email/provider";
import { GoogleReviewsError, type GoogleReview, type ReviewSource } from "../google/businessProfile";
import { decryptRefreshToken } from "../google/tokenCrypto";
import { escapeHtml as e } from "../inbox/auth";
import { DELIVERED_ACTION } from "../requests/delivery";
import { DIGEST_HOUR, inboxUrl, lockLocation, recipients, type Recipient } from "../notifications/ownerEmails";
import { recordOwnerEmailFailure, utcMonth } from "../notifications/sendFailures";

const ACTOR = "system:monthly_report";
const SENT_ACTION = "monthly_report_sent";

export type MonthlyReportDeps = {
  email: EmailProvider;
  source: ReviewSource;
  tokenSecret: string;
  baseUrl: string;
  now?: Date;
};
export type MonthlyReportResult = { sent: number; failed: number; waiting: number };

// ---- Time zones -------------------------------------------------------------------------------------------------

function zonedParts(t: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(t)
      .map((x) => [x.type, x.value]),
  );
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
}

// The instant of local midnight on the first of a month (month 1-12; 13 rolls into the next year).
export function startOfLocalMonth(year: number, month: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, 1);
  let t = wall;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(t), timeZone);
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
    const next = wall - offset;
    if (next === t) break;
    t = next;
  }
  return new Date(t);
}

// The calendar month before `now` in the location's time zone, and whether the report for it is due yet.
export function reportPeriod(now: Date, timeZone: string, sendHour = DIGEST_HOUR) {
  const p = zonedParts(now, timeZone); // throws on a bad time zone
  const year = p.month === 1 ? p.year - 1 : p.year;
  const month = p.month === 1 ? 12 : p.month - 1;
  return {
    key: `${year}-${String(month).padStart(2, "0")}`,
    label: new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
      new Date(Date.UTC(year, month - 1, 1)),
    ),
    start: startOfLocalMonth(year, month, timeZone),
    end: startOfLocalMonth(p.year, p.month, timeZone),
    due: p.day > 1 || p.hour >= sendHour,
    localDay: p.day,
  };
}

// ---- Figures ----------------------------------------------------------------------------------------------------

export type OwnFigures = {
  requestsSent: number;
  remindersSent: number;
  delivered: number | null; // null: no delivery receipts for this month's sends (see the header)
  linkClicks: number;
  optOuts: number;
  repliesApproved: number;
  medianMinutesToApprove: number | null;
  repliesPosted: number;
};
export type GoogleFigures = { newReviews: number; averageRating: number | null; medianHoursToReply: number | null };

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// From the live fetch, in memory only.
export function googleFigures(found: GoogleReview[], start: Date, end: Date): GoogleFigures {
  const inMonth = found.filter((r) => r.createdAt && r.createdAt >= start && r.createdAt < end);
  const hours = inMonth.flatMap((r) =>
    r.repliedAt && r.createdAt && r.repliedAt >= r.createdAt
      ? [(r.repliedAt.getTime() - r.createdAt.getTime()) / 3_600_000]
      : [],
  );
  return {
    newReviews: inMonth.length,
    averageRating: inMonth.length ? inMonth.reduce((a, r) => a + r.rating, 0) / inMonth.length : null,
    medianHoursToReply: median(hours),
  };
}

export async function ownFigures(db: Pick<Db, "select">, locationId: string, start: Date, end: Date) {
  const sentIn = (attempt: 1 | 2) =>
    db
      .select({ n: count() })
      .from(reviewRequests)
      .innerJoin(visits, eq(visits.id, reviewRequests.visitId))
      .where(
        and(
          eq(visits.locationId, locationId),
          eq(reviewRequests.attempt, attempt),
          eq(reviewRequests.status, "sent"),
          gte(reviewRequests.sentAt, start),
          lt(reviewRequests.sentAt, end),
        ),
      );
  const [[requests], [reminders], [delivered], [clicks], [optOuts], approvals, [posted]] = await Promise.all([
    sentIn(1),
    sentIn(2),
    // Sent in the month (request or reminder) and confirmed delivered, whenever the receipt came in.
    db
      .select({ n: count() })
      .from(reviewRequests)
      .innerJoin(visits, eq(visits.id, reviewRequests.visitId))
      .where(
        and(
          eq(visits.locationId, locationId),
          eq(reviewRequests.status, "sent"),
          gte(reviewRequests.sentAt, start),
          lt(reviewRequests.sentAt, end),
          exists(
            db
              .select({ one: sql`1` })
              .from(auditLog)
              .where(
                and(
                  eq(auditLog.locationId, locationId), // uses the (location_id, at) index
                  eq(auditLog.entity, "review_request"),
                  eq(auditLog.entityId, reviewRequests.id),
                  eq(auditLog.action, DELIVERED_ACTION),
                ),
              ),
          ),
        ),
      ),
    db
      .select({ n: count() })
      .from(reviewRequests)
      .innerJoin(visits, eq(visits.id, reviewRequests.visitId))
      .where(
        and(eq(visits.locationId, locationId), gte(reviewRequests.clickedAt, start), lt(reviewRequests.clickedAt, end)),
      ),
    db
      .select({ n: count() })
      .from(suppressionList)
      .where(
        and(
          eq(suppressionList.locationId, locationId),
          gte(suppressionList.createdAt, start),
          lt(suppressionList.createdAt, end),
        ),
      ),
    // Approvals come from the audit log (append-only; drafts are purged with their review). Its detail carries the
    // minutes from draft to approval (src/inbox/inbox.ts).
    db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.locationId, locationId),
          eq(auditLog.entity, "reply_draft"),
          eq(auditLog.action, "approved"),
          gte(auditLog.at, start),
          lt(auditLog.at, end),
        ),
      ),
    db
      .select({ n: count() })
      .from(replyDrafts)
      .where(
        and(
          eq(replyDrafts.locationId, locationId),
          isNotNull(replyDrafts.postedAt),
          gte(replyDrafts.postedAt, start),
          lt(replyDrafts.postedAt, end),
        ),
      ),
  ]);
  const minutes = approvals.flatMap((a) => {
    const m = /(?:^|;)minutes=(\d+)(?:;|$)/.exec(a.detail ?? "");
    return m ? [Number(m[1])] : [];
  });
  return {
    requestsSent: requests.n,
    remindersSent: reminders.n,
    delivered: delivered.n > 0 ? delivered.n : null,
    linkClicks: clicks.n,
    optOuts: optOuts.n,
    repliesApproved: approvals.length,
    medianMinutesToApprove: median(minutes),
    repliesPosted: posted.n,
  } satisfies OwnFigures;
}

const hasActivity = (f: OwnFigures) =>
  f.requestsSent + f.remindersSent + f.linkClicks + f.optOuts + f.repliesApproved + f.repliesPosted > 0;

// ---- Email ------------------------------------------------------------------------------------------------------

export type GoogleSection =
  { kind: "figures"; figures: GoogleFigures } | { kind: "not_connected" } | { kind: "unavailable" };

function duration(hours: number) {
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"}`;
  return `${Math.round(hours / 24)} days`;
}

export function monthlyReportEmail(
  r: Recipient,
  period: { key: string; label: string },
  own: OwnFigures,
  google: GoogleSection,
  baseUrl: string,
): EmailMessage {
  const head = `Your ${period.label} report for ${r.businessName} (${r.locationName}).`;
  const googleLines =
    google.kind === "figures"
      ? [
          `New reviews on Google: ${google.figures.newReviews}`,
          ...(google.figures.averageRating === null
            ? []
            : [`Average rating of those reviews: ${google.figures.averageRating.toFixed(1)} of 5`]),
          ...(google.figures.medianHoursToReply === null
            ? []
            : [`Typical time to reply (median): ${duration(google.figures.medianHoursToReply)}`]),
        ]
      : google.kind === "not_connected"
        ? [
            "Google review figures need your Google Business Profile connection. Until then this report shows our own figures.",
          ]
        : ["We could not read your Google reviews this time, so this report shows our own figures only."];
  const ownLines = [
    `Review requests sent: ${own.requestsSent}`,
    `Reminders sent: ${own.remindersSent}`,
    ...(own.delivered === null ? [] : [`Requests and reminders delivered: ${own.delivered}`]),
    `Review link clicks: ${own.linkClicks}`,
    `Customers who opted out: ${own.optOuts}`,
    `Replies you approved: ${own.repliesApproved}`,
    ...(own.medianMinutesToApprove === null
      ? []
      : [`Typical time to approve (median): ${duration(own.medianMinutesToApprove / 60)}`]),
    `Replies posted to Google: ${own.repliesPosted}`,
  ];
  const note = "Every reply waits for your approval before it is posted.";
  const url = inboxUrl(baseUrl, r.locationId);
  const text = [
    head,
    "",
    "Google reviews",
    ...googleLines.map((l) => `- ${l}`),
    "",
    "Requests and replies",
    ...ownLines.map((l) => `- ${l}`),
    "",
    `Open your reply inbox: ${url}`,
    "",
    note,
  ].join("\n");
  const list = (ls: string[]) => `<ul>${ls.map((l) => `<li>${e(l)}</li>`).join("")}</ul>`;
  const html = `<p>${e(head)}</p><h2>Google reviews</h2>${list(googleLines)}<h2>Requests and replies</h2>${list(
    ownLines,
  )}<p><a href="${e(url)}">Open your reply inbox</a></p><p>${e(note)}</p>`;
  return {
    to: r.ownerEmail,
    fromName: "Kindword",
    subject: `${period.label} review report: ${r.businessName}`,
    text,
    html,
    headers: {},
    idempotencyKey: `monthly-report/${r.locationId}/${period.key}`,
  };
}

// ---- Run --------------------------------------------------------------------------------------------------------

async function connection(db: Db, locationId: string) {
  const [row] = await db
    .select({ googleLocationId: locations.googleLocationId, encrypted: oauthTokens.encryptedRefreshToken })
    .from(locations)
    .innerJoin(oauthTokens, eq(oauthTokens.locationId, locations.id))
    .where(
      and(
        eq(locations.id, locationId),
        isNotNull(locations.googleLocationId),
        eq(oauthTokens.status, "active"),
        isNull(oauthTokens.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

const alreadySent = (tx: Pick<Db, "select">, locationId: string, key: string) =>
  tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.locationId, locationId),
        eq(auditLog.entity, "location"),
        eq(auditLog.entityId, locationId),
        eq(auditLog.action, SENT_ACTION),
        eq(auditLog.detail, `month=${key}`),
      ),
    )
    .limit(1);

export async function sendMonthlyReports(
  deps: MonthlyReportDeps,
  opts: { sendHour?: number } = {},
  db: Db = defaultDb,
): Promise<MonthlyReportResult> {
  const now = deps.now ?? new Date();
  const result: MonthlyReportResult = { sent: 0, failed: 0, waiting: 0 };
  for (const r of await recipients(db)) {
    let month = utcMonth(now); // the reported month once the time zone has been read
    try {
      const period = reportPeriod(now, r.timezone, opts.sendHour); // throws on a bad time zone: counted as failed
      month = period.key;
      if (!period.due) continue;
      if ((await alreadySent(db, r.locationId, period.key)).length) continue; // cheap check before the Google read

      // Live Google read, outside the transaction (it can take seconds). Figures stay in memory.
      let google: GoogleSection = { kind: "not_connected" };
      const conn = await connection(db, r.locationId);
      if (conn) {
        const refreshToken = decryptRefreshToken(conn.encrypted, r.locationId, deps.tokenSecret);
        try {
          if (!refreshToken) throw new GoogleReviewsError(0, "token_unreadable", false);
          const found = await deps.source.listReviews({ googleLocationId: conn.googleLocationId!, refreshToken });
          google = { kind: "figures", figures: googleFigures(found, period.start, period.end) };
        } catch (err) {
          // A passing outage: wait for a later run on the 1st or 2nd so the owner gets the full report; after that,
          // or for a lasting failure (revoked access, bad configuration), send our own figures with a note.
          const retryable = !(err instanceof GoogleReviewsError) || err.retryable;
          if (retryable && period.localDay <= 2) {
            result.waiting++;
            continue;
          }
          google = { kind: "unavailable" };
        }
      }

      const sent = await db.transaction(async (tx) => {
        await lockLocation(tx, "monthly-report", r.locationId);
        if ((await alreadySent(tx, r.locationId, period.key)).length) return false;
        const own = await ownFigures(tx, r.locationId, period.start, period.end);
        if (google.kind === "not_connected" && !hasActivity(own)) return false; // nothing to report
        await deps.email.send(monthlyReportEmail(r, period, own, google, deps.baseUrl));
        await tx.insert(auditLog).values({
          locationId: r.locationId,
          entity: "location",
          entityId: r.locationId,
          action: SENT_ACTION,
          actor: ACTOR,
          detail: `month=${period.key}`, // the month only: no figures, nothing derived from reviews
        });
        return true;
      });
      if (sent) result.sent++;
    } catch (err) {
      // The email provider refused or timed out, or the time zone is bad: no send recorded, so the next run tries
      // again under the same idempotency key. No details logged (they may hold the address); the failure record for
      // operator alerts holds the location, the month and an error code only.
      result.failed++;
      await recordOwnerEmailFailure(
        { locationId: r.locationId, kind: "monthly_report", period: month, error: err, at: now },
        db,
      );
    }
  }
  return result;
}
