// Owner notification emails (SPEC FR-13, Flow 3 steps 3 and 5): one digest email a day per location, only on days
// with drafts waiting, linking to the approval inbox and marking drafts waiting 48 hours or more as overdue; and an
// immediate email when a review of 2 stars or lower arrives. Owner emails only; owner texts wait for a later version.
//
// What the emails carry: the business and location names, star ratings, how long each draft has waited and whether
// it is flagged or overdue. Never review text, reviewer names or reply text: the owner reads those in the inbox,
// behind sign-in, and the email stays free of review content (Data model rules; Security: minimum personal data).
//
// Who gets them: the business's owner_email, the address sign-in links go to (src/inbox/auth.ts), so an owner the
// operator set up without an account is covered too. Nothing goes to an offboarded business or a disabled account.
//
// Idempotent (SPEC Reliability): each send runs under a per-location advisory lock, checks the audit log for an
// earlier send, sends with a stable provider idempotency key, and records the send in the same transaction. A retry
// after a crash between the send and the commit is caught by the provider's key (Resend keeps keys for 24 hours).
// Audit rows carry IDs, dates and counts of our own drafts only. Nothing here logs an email address.
//
// No scheduler is chosen yet, so callers invoke these: sendDailyDigests every hour or more often (each location gets
// its digest on the first run at or after DIGEST_HOUR local time), sendLowRatingAlerts every few minutes.
import { and, asc, eq, inArray, isNull, lte, ne, notExists, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { auditLog, businesses, locations, ownerAccounts, replyDrafts, reviews } from "../db/schema";
import type { EmailMessage, EmailProvider } from "../email/provider";
import { escapeHtml as e } from "../inbox/auth";
import { OVERDUE_MS } from "../inbox/inbox";
import { recordOwnerEmailFailure, utcDay } from "./sendFailures";

// Local hour from which a location's digest may go out. The SPEC says one digest a day; the time of day is ours.
export const DIGEST_HOUR = 8;
export const LOW_RATING_MAX = 2; // "A review of 2 stars or lower also triggers an immediate email" (Flow 3 step 3)
const ACTOR = "system:owner_email";

export type OwnerEmailDeps = { email: EmailProvider; baseUrl: string; now?: Date };
export type OwnerEmailResult = { sent: number; failed: number };

export type Recipient = {
  locationId: string;
  locationName: string;
  timezone: string;
  businessName: string;
  ownerEmail: string;
};

// Locations whose owner can be emailed: an owner email on file, the business not offboarded, and no disabled
// account. Same eligibility as the emailed sign-in link (src/inbox/linkRequest.ts).
export async function recipients(db: Db, locationIds?: string[]): Promise<Recipient[]> {
  const rows = await db
    .select({
      locationId: locations.id,
      locationName: locations.name,
      timezone: locations.timezone,
      businessName: businesses.name,
      ownerEmail: businesses.ownerEmail,
    })
    .from(locations)
    .innerJoin(businesses, eq(businesses.id, locations.businessId))
    .leftJoin(ownerAccounts, eq(ownerAccounts.businessId, businesses.id))
    .where(
      and(
        ne(businesses.status, "offboarded"),
        isNull(ownerAccounts.disabledAt),
        locationIds ? inArray(locations.id, locationIds) : undefined,
      ),
    )
    .orderBy(asc(locations.id));
  return rows.flatMap((r) => {
    const ownerEmail = r.ownerEmail?.trim().toLowerCase();
    return ownerEmail ? [{ ...r, ownerEmail }] : [];
  });
}

// The location's calendar date and hour, in its own time zone (daylight saving from the zone database).
export function localDayAndHour(t: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
    })
      .formatToParts(t)
      .map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}

// Serializes sends for one location and one kind of email across concurrent runs; released at commit.
export const lockLocation = (tx: Pick<Db, "execute">, kind: string, locationId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${kind}:${locationId}`}))`);

const stars = (n: number) => `${"★".repeat(n)}${"☆".repeat(5 - n)}`;
// Names the location: an owner session covers one location, so /inbox alone could open another location's inbox
// for a business with several (audit F-40-1). /inbox checks the parameter against the session.
export const inboxUrl = (baseUrl: string, locationId: string) => `${baseUrl}/inbox?location=${locationId}`;

function waited(createdAt: Date, now: Date) {
  const hours = Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / (60 * 60 * 1000)));
  if (hours < 1) return "waiting less than an hour";
  if (hours < 48) return `waiting ${hours} hour${hours === 1 ? "" : "s"}`;
  return `waiting ${Math.floor(hours / 24)} days`;
}

const signInHelp = (baseUrl: string) =>
  `If you are signed out, sign in at ${baseUrl}/account/sign-in or get a sign-in link by email at ${baseUrl}/account/sign-in/link.`;
const signInHelpHtml = (baseUrl: string) =>
  `<p>If you are signed out, <a href="${e(`${baseUrl}/account/sign-in`)}">sign in</a> or <a href="${e(`${baseUrl}/account/sign-in/link`)}">get a sign-in link by email</a>.</p>`;
const approvalNote = "Nothing is posted until you approve it.";

type DigestDraft = { rating: number; status: string; createdAt: Date };

export function digestEmail(r: Recipient, drafts: DigestDraft[], day: string, baseUrl: string, now: Date) {
  const n = drafts.length;
  const overdue = drafts.filter((d) => now.getTime() - d.createdAt.getTime() >= OVERDUE_MS).length;
  const lines = drafts.map((d) => {
    const late = now.getTime() - d.createdAt.getTime() >= OVERDUE_MS;
    const parts = [`${d.rating}-star review`, waited(d.createdAt, now)];
    if (d.status === "held") parts.push("needs extra care");
    if (late) parts.push("overdue");
    return { text: parts.join(", "), stars: stars(d.rating), late };
  });
  const head = `${n} ${n === 1 ? "reply is" : "replies are"} waiting for your approval at ${r.businessName} (${r.locationName})${
    overdue ? `, ${overdue} overdue (waiting 48 hours or more)` : ""
  }.`;
  const url = inboxUrl(baseUrl, r.locationId);
  const text = [
    head,
    "",
    ...lines.map((l) => `- ${l.text}`),
    "",
    `Open your reply inbox: ${url}`,
    signInHelp(baseUrl),
    "",
    approvalNote,
  ].join("\n");
  const html = `<p>${e(head)}</p><ul>${lines
    .map(
      (l) =>
        `<li><span aria-hidden="true">${l.stars}</span> ${e(l.text)}${l.late ? " <strong>(overdue)</strong>" : ""}</li>`,
    )
    .join(
      "",
    )}</ul><p><a href="${e(url)}">Open your reply inbox</a></p>${signInHelpHtml(baseUrl)}<p>${e(approvalNote)}</p>`;
  return {
    to: r.ownerEmail,
    fromName: "Kindword",
    subject: `${n} ${n === 1 ? "reply" : "replies"} waiting for you: ${r.businessName}${overdue ? ` (${overdue} overdue)` : ""}`,
    text,
    html,
    headers: {},
    idempotencyKey: `owner-digest/${r.locationId}/${day}`,
  } satisfies EmailMessage;
}

// One digest per location per local day, on days with drafts waiting (awaiting_owner or held), sent on the first
// run at or after DIGEST_HOUR local time. A draft stays in every digest until the owner acts (Flow 3 step 5).
export async function sendDailyDigests(
  deps: OwnerEmailDeps,
  opts: { digestHour?: number } = {},
  db: Db = defaultDb,
): Promise<OwnerEmailResult> {
  const now = deps.now ?? new Date();
  const digestHour = opts.digestHour ?? DIGEST_HOUR;
  // Only locations with something waiting; drafts newer than now (clock skew in tests) are left for the next run.
  const waiting = await db
    .selectDistinct({ locationId: replyDrafts.locationId })
    .from(replyDrafts)
    .where(and(inArray(replyDrafts.status, ["awaiting_owner", "held"]), lte(replyDrafts.createdAt, now)));
  if (!waiting.length) return { sent: 0, failed: 0 };

  const result = { sent: 0, failed: 0 };
  for (const r of await recipients(
    db,
    waiting.map((w) => w.locationId),
  )) {
    let period = utcDay(now); // the local day once the time zone has been read
    try {
      const { day, hour } = localDayAndHour(now, r.timezone); // throws on a bad time zone: counted as failed
      period = day;
      if (hour < digestHour) continue;
      const sent = await db.transaction(async (tx) => {
        await lockLocation(tx, "owner-digest", r.locationId);
        const [already] = await tx
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.locationId, r.locationId),
              eq(auditLog.entity, "location"),
              eq(auditLog.entityId, r.locationId),
              eq(auditLog.action, "owner_digest_sent"),
              eq(auditLog.detail, `day=${day}`),
            ),
          )
          .limit(1);
        if (already) return false;
        const drafts = await tx
          .select({ rating: reviews.rating, status: replyDrafts.status, createdAt: replyDrafts.createdAt })
          .from(replyDrafts)
          .innerJoin(reviews, and(eq(reviews.id, replyDrafts.reviewId), eq(reviews.locationId, replyDrafts.locationId)))
          .where(
            and(
              eq(replyDrafts.locationId, r.locationId),
              inArray(replyDrafts.status, ["awaiting_owner", "held"]),
              lte(replyDrafts.createdAt, now),
            ),
          )
          .orderBy(asc(replyDrafts.createdAt));
        if (!drafts.length) return false; // the owner cleared the inbox since the first query
        await deps.email.send(digestEmail(r, drafts, day, deps.baseUrl, now));
        await tx.insert(auditLog).values({
          locationId: r.locationId,
          entity: "location",
          entityId: r.locationId,
          action: "owner_digest_sent",
          actor: ACTOR,
          detail: `day=${day}`,
        });
        return true;
      });
      if (sent) result.sent++;
    } catch (err) {
      // The email provider refused or timed out: no send was recorded, so the next run tries again under the same
      // idempotency key. One location's failure does not stop the others. No details logged (they may hold the
      // address); the failure record for operator alerts holds the location, the day and an error code only.
      result.failed++;
      await recordOwnerEmailFailure({ locationId: r.locationId, kind: "digest", period, error: err, at: now }, db);
    }
  }
  return result;
}

export function lowRatingEmail(r: Recipient, ratings: number[], reviewIds: string[], baseUrl: string) {
  const n = ratings.length;
  const head =
    n === 1
      ? `A new ${ratings[0]}-star review for ${r.businessName} (${r.locationName}) needs a reply.`
      : `${n} new reviews of 2 stars or lower for ${r.businessName} (${r.locationName}) need a reply.`;
  const body =
    "We are drafting a suggested reply for each one. You will find it in your reply inbox, marked for extra care.";
  const url = inboxUrl(baseUrl, r.locationId);
  const list = n === 1 ? [] : ratings.map((x) => `- ${x}-star review`);
  const text = [
    head,
    ...(list.length ? ["", ...list] : []),
    "",
    body,
    "",
    `Open your reply inbox: ${url}`,
    signInHelp(baseUrl),
    "",
    approvalNote,
  ].join("\n");
  const html = `<p>${e(head)}</p>${
    list.length ? `<ul>${ratings.map((x) => `<li>${e(`${x}-star review`)}</li>`).join("")}</ul>` : ""
  }<p>${e(body)}</p><p><a href="${e(url)}">Open your reply inbox</a></p>${signInHelpHtml(baseUrl)}<p>${e(approvalNote)}</p>`;
  return {
    to: r.ownerEmail,
    fromName: "Kindword",
    subject:
      n === 1 ? `New ${ratings[0]}-star review: ${r.businessName}` : `${n} new low-rated reviews: ${r.businessName}`,
    text,
    html,
    headers: {},
    // Stable for this exact set of reviews, so a retry of the same email is not sent twice. shortcut: if a send's
    // outcome was lost and a new low-rated review arrives before the retry, the retry is a new email that repeats
    // the earlier reviews; rare, and a repeated alert is a small harm.
    idempotencyKey: `low-rating/${r.locationId}/${[...reviewIds].sort().join(",")}`.slice(0, 256),
  } satisfies EmailMessage;
}

// Unanswered reviews of 2 stars or lower that the owner has not been emailed about yet. A review the owner already
// answered (on Google, or by approving or rejecting our draft) needs no alert.
function unalertedLowRatings(tx: Pick<Db, "select">, locationId?: string) {
  return tx
    .select({ id: reviews.id, locationId: reviews.locationId, rating: reviews.rating })
    .from(reviews)
    .where(
      and(
        locationId ? eq(reviews.locationId, locationId) : undefined,
        lte(reviews.rating, LOW_RATING_MAX),
        eq(reviews.hasReply, false),
        notExists(
          tx
            .select({ x: sql`1` })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.entity, "review"),
                eq(auditLog.entityId, reviews.id),
                eq(auditLog.action, "low_rating_email_sent"),
              ),
            ),
        ),
        notExists(
          tx
            .select({ x: sql`1` })
            .from(replyDrafts)
            .where(
              and(
                eq(replyDrafts.reviewId, reviews.id),
                inArray(replyDrafts.status, ["approved", "rejected", "posted"]),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(reviews.fetchedAt), asc(reviews.id));
}

// The immediate email for reviews of 2 stars or lower. One email per location per run, covering every new low-rated
// review found since the last run (so a first fetch of old reviews sends one email, not one per review).
export async function sendLowRatingAlerts(deps: OwnerEmailDeps, db: Db = defaultDb): Promise<OwnerEmailResult> {
  const now = deps.now ?? new Date();
  const found = await unalertedLowRatings(db);
  if (!found.length) return { sent: 0, failed: 0 };

  const result = { sent: 0, failed: 0 };
  for (const r of await recipients(db, [...new Set(found.map((f) => f.locationId))])) {
    try {
      const sent = await db.transaction(async (tx) => {
        await lockLocation(tx, "low-rating", r.locationId);
        const rows = await unalertedLowRatings(tx, r.locationId); // re-read under the lock
        if (!rows.length) return false;
        await deps.email.send(
          lowRatingEmail(
            r,
            rows.map((x) => x.rating),
            rows.map((x) => x.id),
            deps.baseUrl,
          ),
        );
        await tx.insert(auditLog).values(
          rows.map((x) => ({
            locationId: r.locationId,
            entity: "review",
            entityId: x.id,
            action: "low_rating_email_sent",
            actor: ACTOR,
            at: now,
          })),
        );
        return true;
      });
      if (sent) result.sent++;
    } catch (err) {
      result.failed++; // retried on the next run under the same idempotency key; nothing logged
      await recordOwnerEmailFailure(
        { locationId: r.locationId, kind: "low_rating", period: utcDay(now), error: err, at: now },
        db,
      );
    }
  }
  return result;
}
