// Review requests (SPEC Flow 2, FR-5, FR-6, FR-7, FR-9, FR-10). Results, errors and audit rows carry IDs and reason
// codes only, never phone numbers, emails or message text.
//
// Every eligible visit gets exactly one request row (attempt 1), scheduled or skipped with a reason; nothing filters
// by expected sentiment (FR-10). Non-clickers get one reminder (attempt 2) on the same channel. No scheduler is
// chosen yet, so callers run runReviewRequestJobs (or the three steps) every few minutes.
import { and, asc, eq, inArray, isNotNull, isNull, lte, notExists, or, sql, gt, lt, ne } from "drizzle-orm";
import { z } from "zod";
import { db as defaultDb, type Db } from "../db/client";
import {
  auditLog,
  businesses,
  customers,
  pendingReceipts,
  locations,
  reviewRequests,
  skipReason,
  suppressionList,
  visits,
  type channel,
} from "../db/schema";
import type { EmailProvider } from "../email/provider";
import { optOut, unsubscribeToken } from "../optout/optout";
import type { SmsProvider } from "../sms/provider";
import { DELIVERED_ACTION, recordDelivery, type DeliveryChannel } from "./delivery";
import { pickLanguage, reviewEmail, smsBody, type Attempt } from "./messages";
import { inSendWindow, nextSendTime } from "./window";

type Channel = (typeof channel.enumValues)[number];
type SkipReason = (typeof skipReason.enumValues)[number];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Customer = typeof customers.$inferSelect;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BATCH = 200;
// F-12-2: an email send that hit a retryable provider error (outage, timeout, 429) goes back to scheduled for a later
// run instead of failing for good: at most EMAIL_MAX_SENDS sends, 15 min, 30 min, 1 h, 2 h apart (or Resend's longer
// Retry-After), inside the send window, before the row goes stale, and never later than EMAIL_RETRY_WINDOW_MS after
// a send that may have reached the customer, because the idempotency key that makes the retry safe lasts 24 hours at
// Resend. Texts are not retried: Twilio has no idempotency key, so a retry after a timeout could send twice.
const EMAIL_MAX_SENDS = 5;
const EMAIL_RETRY_BASE_MS = 15 * 60 * 1000;
export const EMAIL_RETRY_WINDOW_MS = 20 * HOUR;

export type RequestJobOptions = {
  now?: Date;
  delayMs?: number; // after the visit (FR-5 default: 2 hours of elapsed time)
  staleMs?: number; // a message that cannot go out this long after it was due is skipped (FR-5: 72 hours)
  reminderDelayMs?: number; // after the request was sent (FR-5: 3 days); shorten it to test Gate 1
  dedupMs?: number; // FR-9: 90 days
};
const opts = (o: RequestJobOptions) => ({
  now: o.now ?? new Date(),
  delayMs: o.delayMs ?? 2 * HOUR,
  staleMs: o.staleMs ?? 72 * HOUR,
  reminderDelayMs: o.reminderDelayMs ?? 3 * DAY,
  dedupMs: o.dedupMs ?? 90 * DAY,
});

export type Providers = { sms: SmsProvider; email: EmailProvider };
export type SendConfig = { baseUrl: string; postalAddress: string };

// Checked before anything is claimed, so a missing setting can never mark requests failed.
export function sendConfigFromEnv(env: Record<string, string | undefined> = process.env): SendConfig {
  const baseUrl = env.APP_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl || !/^https?:\/\//.test(baseUrl) || !URL.canParse(baseUrl))
    throw new Error("APP_BASE_URL missing or not an http(s) URL");
  const postalAddress = env.MAIL_POSTAL_ADDRESS?.trim();
  if (!postalAddress) throw new Error("MAIL_POSTAL_ADDRESS missing (CAN-SPAM footer)");
  if (!env.UNSUBSCRIBE_SECRET || env.UNSUBSCRIBE_SECRET.length < 32)
    throw new Error("UNSUBSCRIBE_SECRET missing or shorter than 32 chars");
  return { baseUrl, postalAddress };
}

// F-7-5: one bad row (e.g. a stored time zone Intl rejects) must not abort the run for every other tenant. It is
// counted and logged by ID and error class only, then retried on the next run.
const rowError = (job: string, id: string) => (e: unknown) => {
  console.error(`${job}: row failed id=${id} error=${e instanceof Error ? e.name : "unknown"}`);
  return "error" as const;
};

// Rows whose location time zone Postgres does not know go last, so they can never fill a batch and starve others.
const badZoneLast = sql`case when ${locations.timezone} in (select name from pg_timezone_names) then 0 else 1 end`;

const lockLocation = (tx: Tx, locationId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`review_requests:${locationId}`}))`);

const audit = (q: Tx | Db, locationId: string, requestId: string, action: string, detail: string) =>
  q
    .insert(auditLog)
    .values({ locationId, entity: "review_request", entityId: requestId, action, actor: "system", detail });

// FR-8: never message an opted-out customer. Stricter than per channel: an opt-out on either of the customer's
// addresses (here or platform-wide) stops every review request to them.
async function isOptedOut(tx: Tx, locationId: string, c: Customer) {
  if (c.optedOutAt) return true;
  const addresses = [
    c.normalizedPhone && and(eq(suppressionList.channel, "sms"), eq(suppressionList.address, c.normalizedPhone)),
    c.normalizedEmail && and(eq(suppressionList.channel, "email"), eq(suppressionList.address, c.normalizedEmail)),
  ].filter((x) => !!x);
  if (!addresses.length) return false;
  const [hit] = await tx
    .select({ id: suppressionList.id })
    .from(suppressionList)
    .where(and(or(...addresses), or(isNull(suppressionList.locationId), eq(suppressionList.locationId, locationId))))
    .limit(1);
  return !!hit;
}

// FR-9: the same person (same customer, or same normalized phone or email) asked at this location within 90 days of
// `at`, by a request that went out, is still due, or failed in a way that may have reached them (outcome unknown).
// Skipped requests and definite failures do not count.
// A request is dated by when it may have reached the customer, not only by when it was due (audit O-43-1): it spans
// from its first possible send (maybe_sent_at, else sent_at, else scheduled_for) to its last (the latest of sent_at,
// maybe_sent_at and scheduled_for; greatest() skips nulls), and counts if any part of that span is within 90 days.
// A send that went out late is then dated by when it went out, and an email retried through an outage by both its
// first and its last send.
const firstContact = sql`coalesce(${reviewRequests.maybeSentAt}, ${reviewRequests.sentAt}, ${reviewRequests.scheduledFor})`;
const lastContact = sql`greatest(${reviewRequests.sentAt}, ${reviewRequests.maybeSentAt}, ${reviewRequests.scheduledFor})`;
async function askedRecently(tx: Tx, locationId: string, visitId: string, c: Customer, at: Date, dedupMs: number) {
  const [hit] = await tx
    .select({ id: reviewRequests.id })
    .from(reviewRequests)
    .innerJoin(visits, eq(visits.id, reviewRequests.visitId))
    .innerJoin(customers, eq(customers.id, visits.customerId))
    .where(
      and(
        eq(visits.locationId, locationId),
        ne(visits.id, visitId),
        eq(reviewRequests.attempt, 1),
        or(
          inArray(reviewRequests.status, ["scheduled", "sent"]),
          and(eq(reviewRequests.status, "failed"), eq(reviewRequests.outcomeUnknown, true)),
          isNotNull(reviewRequests.maybeSentAt),
        ),
        or(
          eq(customers.id, c.id),
          c.normalizedPhone ? eq(customers.normalizedPhone, c.normalizedPhone) : undefined,
          c.normalizedEmail ? eq(customers.normalizedEmail, c.normalizedEmail) : undefined,
        ),
        gt(lastContact, new Date(at.getTime() - dedupMs)),
        lt(firstContact, new Date(at.getTime() + dedupMs)),
      ),
    )
    .limit(1);
  return !!hit;
}

export type ScheduleResult = { scheduled: number; skipped: Partial<Record<SkipReason, number>>; errors?: number };

// Creates the attempt-1 row for every visit that has none: scheduled for the visit time plus the delay, moved into
// the location's 9 a.m. to 8 p.m. window, or skipped as opted_out, stale or duplicate.
export async function scheduleReviewRequests(o: RequestJobOptions = {}, db: Db = defaultDb): Promise<ScheduleResult> {
  const { now, delayMs, staleMs, dedupMs } = opts(o);
  const result: ScheduleResult = { scheduled: 0, skipped: {} };
  const hasRequest = db
    .select({ x: sql`1` })
    .from(reviewRequests)
    .where(and(eq(reviewRequests.visitId, visits.id), eq(reviewRequests.attempt, 1)));
  const pending = await db
    .select({ id: visits.id, locationId: visits.locationId })
    .from(visits)
    .innerJoin(locations, eq(locations.id, visits.locationId))
    .where(notExists(hasRequest))
    .orderBy(badZoneLast, asc(visits.visitAt))
    .limit(BATCH);

  for (const p of pending) {
    const run = db.transaction(async (tx) => {
      await lockLocation(tx, p.locationId); // serializes FR-9 checks per location
      const [row] = await tx
        .select({ visit: visits, customer: customers, location: locations })
        .from(visits)
        .innerJoin(customers, eq(customers.id, visits.customerId))
        .innerJoin(locations, eq(locations.id, visits.locationId))
        .where(eq(visits.id, p.id));
      if (!row) return null; // deleted since the scan
      const [done] = await tx
        .select({ id: reviewRequests.id })
        .from(reviewRequests)
        .where(and(eq(reviewRequests.visitId, p.id), eq(reviewRequests.attempt, 1)));
      if (done) return null; // another run got here first

      const { visit, customer: c, location: l } = row;
      // Text when there is a phone (it always has a consent record) and the location's number is live; until its
      // 10DLC campaign is approved (no sms_number) email is used when there is one (FR-6, Risks).
      const ch: Channel = c.normalizedPhone && (l.smsNumber || !c.normalizedEmail) ? "sms" : "email";
      const scheduledFor = nextSendTime(
        new Date(Math.max(visit.visitAt.getTime() + delayMs, now.getTime())),
        l.timezone,
      );
      const skip: SkipReason | null = (await isOptedOut(tx, l.id, c))
        ? "opted_out"
        : scheduledFor.getTime() > visit.visitAt.getTime() + staleMs
          ? "stale"
          : (await askedRecently(tx, l.id, visit.id, c, scheduledFor, dedupMs))
            ? "duplicate"
            : null;
      const [rr] = await tx
        .insert(reviewRequests)
        .values({
          visitId: visit.id,
          scheduledFor,
          channel: ch,
          attempt: 1,
          status: skip ? "skipped" : "scheduled",
          skipReason: skip,
        })
        .returning({ id: reviewRequests.id });
      await audit(
        tx,
        l.id,
        rr.id,
        skip ? "skipped" : "scheduled",
        `attempt=1;channel=${ch}${skip ? `;reason=${skip}` : ""}`,
      );
      return skip ?? "scheduled";
    });
    const outcome = await run.catch(rowError("schedule_review_requests", p.id));
    if (outcome === null) continue;
    if (outcome === "error") {
      result.errors = (result.errors ?? 0) + 1;
      continue;
    }
    if (outcome === "scheduled") result.scheduled++;
    else result.skipped[outcome] = (result.skipped[outcome] ?? 0) + 1;
  }
  return result;
}

// Creates the one reminder (attempt 2) for every request sent at least reminderDelayMs ago whose link nobody
// clicked, on the same channel. Never a second reminder, never more than 2 messages per job (FR-5).
export async function scheduleReminders(
  o: RequestJobOptions = {},
  db: Db = defaultDb,
): Promise<{ scheduled: number; errors?: number }> {
  const { now, reminderDelayMs } = opts(o);
  const sibling = db
    .select({ x: sql`1` })
    .from(sql`review_requests r2`)
    .where(sql`r2.visit_id = ${reviewRequests.visitId} and (r2.attempt = 2 or r2.clicked_at is not null)`);
  const due = await db
    .select({ id: reviewRequests.id, visitId: reviewRequests.visitId, locationId: visits.locationId })
    .from(reviewRequests)
    .innerJoin(visits, eq(visits.id, reviewRequests.visitId))
    .innerJoin(locations, eq(locations.id, visits.locationId))
    .where(
      and(
        eq(reviewRequests.attempt, 1),
        eq(reviewRequests.status, "sent"),
        lte(reviewRequests.sentAt, new Date(now.getTime() - reminderDelayMs)),
        notExists(sibling),
      ),
    )
    .orderBy(badZoneLast, asc(reviewRequests.sentAt))
    .limit(BATCH);

  let scheduled = 0;
  let errors = 0;
  for (const d of due) {
    const run = db.transaction(async (tx) => {
      await lockLocation(tx, d.locationId);
      const rows = await tx.select().from(reviewRequests).where(eq(reviewRequests.visitId, d.visitId));
      const first = rows.find((r) => r.id === d.id);
      if (!first?.sentAt || rows.some((r) => r.attempt === 2 || r.clickedAt)) return null;
      if (rows.filter((r) => r.status === "sent").length >= 2) return null;
      const [loc] = await tx
        .select({ timezone: locations.timezone })
        .from(locations)
        .where(eq(locations.id, d.locationId));
      const at = new Date(Math.max(first.sentAt.getTime() + reminderDelayMs, now.getTime()));
      const [rr] = await tx
        .insert(reviewRequests)
        .values({
          visitId: d.visitId,
          scheduledFor: nextSendTime(at, loc.timezone),
          channel: first.channel,
          attempt: 2,
        })
        .onConflictDoNothing()
        .returning({ id: reviewRequests.id });
      if (rr) await audit(tx, d.locationId, rr.id, "scheduled", `attempt=2;channel=${first.channel}`);
      return rr?.id ?? null;
    });
    const id = await run.catch(rowError("schedule_reminders", d.id));
    if (id === "error") errors++;
    else if (id) scheduled++;
  }
  return errors ? { scheduled, errors } : { scheduled };
}

export type SendResult = {
  sent: number;
  failed: number;
  deferred: number; // outside the window; moved to the next 9 a.m.
  retrying: number; // email send hit a retryable provider error; scheduled again for a later run (F-12-2)
  waiting: number; // business not live, or no texting number yet; left as is until it is or the row goes stale
  skipped: Partial<Record<SkipReason, number>>;
  // Rows that threw before a claim (e.g. a bad time zone), left scheduled for the next run; or whose outcome could
  // not be written after the provider call (O-46-1), left claimed (sent) and never sent again.
  errors?: number;
};

type Claimed = {
  rr: typeof reviewRequests.$inferSelect;
  customer: Customer;
  location: typeof locations.$inferSelect;
  businessName: string;
  address: string;
  staleAt: number;
};

// Sends every due request and reminder. Each row is claimed (marked sent) and committed before the provider is
// called, so a retry or a concurrent run can never send it twice; a crash right after the claim loses that one
// message instead. Suppression, clicks, staleness and the window are re-checked at send time.
export async function sendDueRequests(
  providers: Providers,
  o: RequestJobOptions & { config?: SendConfig } = {},
  db: Db = defaultDb,
): Promise<SendResult> {
  const cfg = o.config ?? sendConfigFromEnv();
  const { now, staleMs, reminderDelayMs } = opts(o);
  const result: SendResult = { sent: 0, failed: 0, deferred: 0, retrying: 0, waiting: 0, skipped: {} };
  // Rows that can go out now come first. Rows held for a business that is not live, or for a location that cannot
  // text yet, stay due without moving, so ordering by due time alone let 200 of them fill every batch and starve
  // every other tenant's requests until they went stale (FR-5, FR-10: ask every eligible customer).
  const due = await db
    .select({ id: reviewRequests.id })
    .from(reviewRequests)
    .innerJoin(visits, eq(visits.id, reviewRequests.visitId))
    .innerJoin(locations, eq(locations.id, visits.locationId))
    .innerJoin(businesses, eq(businesses.id, locations.businessId))
    .where(and(eq(reviewRequests.status, "scheduled"), lte(reviewRequests.scheduledFor, now)))
    .orderBy(
      badZoneLast,
      sql`case when ${businesses.status} = 'live' and (${reviewRequests.channel} = 'email' or ${locations.smsNumber} is not null) then 0 else 1 end`,
      asc(reviewRequests.scheduledFor),
    )
    .limit(BATCH);

  for (const { id } of due) {
    const run = db.transaction(async (tx): Promise<Claimed | "deferred" | "waiting" | "failed" | SkipReason | null> => {
      const [row] = await tx
        .select({ rr: reviewRequests, visit: visits, customer: customers, location: locations, business: businesses })
        .from(reviewRequests)
        .innerJoin(visits, eq(visits.id, reviewRequests.visitId))
        .innerJoin(customers, eq(customers.id, visits.customerId))
        .innerJoin(locations, eq(locations.id, visits.locationId))
        .innerJoin(businesses, eq(businesses.id, locations.businessId))
        .where(and(eq(reviewRequests.id, id), eq(reviewRequests.status, "scheduled")))
        .for("update", { of: reviewRequests, skipLocked: true });
      if (!row) return null; // claimed by a concurrent run, or no longer scheduled
      const { rr, visit, customer: c, location: l, business: b } = row;
      const skip = async (reason: SkipReason) => {
        await tx
          .update(reviewRequests)
          .set({ status: "skipped", skipReason: reason })
          .where(eq(reviewRequests.id, rr.id));
        await audit(tx, l.id, rr.id, "skipped", `attempt=${rr.attempt};channel=${rr.channel};reason=${reason}`);
        return reason;
      };

      if (await isOptedOut(tx, l.id, c)) return skip("opted_out");
      // A request is due relative to the visit; the reminder relative to when the request went out.
      let dueAt = visit.visitAt.getTime();
      if (rr.attempt === 2) {
        const firsts = await tx
          .select({ sentAt: reviewRequests.sentAt, clickedAt: reviewRequests.clickedAt })
          .from(reviewRequests)
          .where(and(eq(reviewRequests.visitId, visit.id), eq(reviewRequests.attempt, 1)));
        if (firsts.some((f) => f.clickedAt)) return skip("clicked");
        const sentAt = firsts.find((f) => f.sentAt)?.sentAt;
        dueAt = (sentAt ?? rr.scheduledFor).getTime() + (sentAt ? reminderDelayMs : 0);
      }
      const staleAt = dueAt + staleMs;
      // A row already tried (F-12-2) that can no longer go out in time fails instead of being skipped: an earlier
      // send may have reached the customer, and the operator should see it (outcome unknown).
      const tooLate = (t: number) =>
        t > staleAt || (rr.maybeSentAt !== null && t > rr.maybeSentAt.getTime() + EMAIL_RETRY_WINDOW_MS);
      const expire = async () => {
        if (!rr.sendAttempts) return skip("stale");
        await failRequest(tx, rr, l.id, rr.maybeSentAt ? "outcome_unknown" : "provider_rejected");
        return "failed" as const;
      };
      if (tooLate(now.getTime())) return expire();
      if (b.status !== "live") return "waiting"; // onboarding, paused or offboarded: nothing goes out (FR-20)
      if (rr.channel === "sms" && !l.smsNumber) return "waiting"; // 10DLC not approved yet
      const address = rr.channel === "sms" ? c.normalizedPhone : c.normalizedEmail;
      if (!address) return skip("no_consent"); // customer rows are never edited by imports, so not expected
      if (!inSendWindow(now, l.timezone)) {
        const next = nextSendTime(now, l.timezone);
        if (tooLate(next.getTime())) return expire();
        await tx.update(reviewRequests).set({ scheduledFor: next }).where(eq(reviewRequests.id, rr.id));
        return "deferred";
      }
      await tx
        .update(reviewRequests)
        .set({ status: "sent", sentAt: now, sendAttempts: rr.sendAttempts + 1 })
        .where(eq(reviewRequests.id, rr.id));
      return { rr, customer: c, location: l, businessName: b.name, address, staleAt };
    });
    const step = await run.catch(rowError("send_due_requests", id));

    if (step === null) continue;
    if (step === "error") {
      result.errors = (result.errors ?? 0) + 1;
      continue;
    }
    if (step === "failed") {
      result.failed++;
      continue;
    }
    if (step === "deferred" || step === "waiting") {
      result[step]++;
      continue;
    }
    if (typeof step === "string") {
      result.skipped[step] = (result.skipped[step] ?? 0) + 1;
      continue;
    }
    // O-46-1: a database error after the provider call (see recordOutcome) skips only this row; the rest of the
    // batch still goes out. The row stays claimed (sent), so this message is never sent again; it is logged under its
    // own tag because, unlike a row that failed before its claim, it needs the operator. Known gap (owner to decide,
    // PR #94): the reminder query treats it as sent, so its reminder is still scheduled 3 days later.
    const outcome = await deliver(providers, cfg, step, now, db).catch(rowError("send_due_requests_outcome", id));
    if (outcome === "error") result.errors = (result.errors ?? 0) + 1;
    else result[outcome]++;
  }
  return result;
}

// O-46-1: what a send did (sent, failed, retry scheduled) is written after the provider call, in its own
// transaction. A database blip there used to abort the whole run and leave a failed send recorded as sent, so a
// refused text never fell back to email (FR-6). The write is retried a few times. Each try first checks, under the
// row lock, that the outcome is not already recorded, so a try whose commit went through but whose reply was lost
// is not applied twice (no second audit row, no second fallback).
const OUTCOME_WRITE_RETRY_DELAYS_MS = [100, 500];
async function recordOutcome(
  db: Db,
  requestId: string,
  claimedAt: Date,
  write: (tx: Tx) => Promise<void>,
  applied: (tx: Tx) => Promise<boolean> = async () => false,
) {
  for (let i = 0; ; i++) {
    try {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ id: reviewRequests.id })
          .from(reviewRequests)
          .where(
            and(
              eq(reviewRequests.id, requestId),
              eq(reviewRequests.status, "sent"),
              eq(reviewRequests.sentAt, claimedAt),
            ),
          )
          .for("update");
        if (!row || (await applied(tx))) return; // already recorded by an earlier try
        await write(tx);
      });
      return;
    } catch (e) {
      if (i >= OUTCOME_WRITE_RETRY_DELAYS_MS.length) throw e;
      await new Promise((r) => setTimeout(r, OUTCOME_WRITE_RETRY_DELAYS_MS[i]));
    }
  }
}

type Failure = "provider_opted_out" | "provider_rejected" | "outcome_unknown" | "carrier_undelivered";
async function failRequest(tx: Tx, rr: typeof reviewRequests.$inferSelect, locationId: string, error: Failure) {
  await tx
    .update(reviewRequests)
    .set({ status: "failed", sentAt: null, outcomeUnknown: error === "outcome_unknown" })
    .where(eq(reviewRequests.id, rr.id));
  await audit(tx, locationId, rr.id, "failed", `attempt=${rr.attempt};channel=${rr.channel};error=${error}`);
}

async function deliver(
  providers: Providers,
  cfg: SendConfig,
  s: Claimed,
  now: Date,
  db: Db,
): Promise<"sent" | "failed" | "retrying"> {
  const { rr, customer: c, location: l } = s;
  const attempt = rr.attempt as Attempt;
  const lang = pickLanguage(c.language);
  const link = `${cfg.baseUrl}/r/${rr.id}`;
  let messageId: string | void;
  try {
    messageId =
      rr.channel === "sms"
        ? await providers.sms.send(l.smsNumber!, s.address, smsBody(lang, attempt, s.businessName, link))
        : await providers.email.send({
            ...reviewEmail({
              lang,
              attempt,
              business: s.businessName,
              to: s.address,
              link,
              unsubscribeUrl: `${cfg.baseUrl}/u/${unsubscribeToken(l.id, s.address)}`,
              postalAddress: cfg.postalAddress,
            }),
            // A row is one message (request or reminder), so a retried job never sends it twice.
            idempotencyKey: `review-request/${rr.id}`,
          });
  } catch (e) {
    // Provider errors can echo the recipient, so only these flags are read. Adapters retry short blips themselves.
    // `refused`: the provider answered and did not take the message. Anything else (a timeout, a lost connection, an
    // ambiguous 5xx) may have gone out, so it never falls back to the other channel. `retryable`: a later try may
    // work (an outage, a rate limit); `retryAfterMs`: how long the provider asked us to wait.
    const err = e as {
      refused?: unknown;
      recipientOptedOut?: unknown;
      retryable?: unknown;
      retryAfterMs?: unknown;
    } | null;
    // Twilio 21610: the customer texted STOP to the provider. Record the opt-out here too (FR-8: suppression applies
    // to provider callbacks and future imports) and send nothing else.
    const providerOptOut = rr.channel === "sms" && err?.recipientOptedOut === true;
    const refused = providerOptOut || err?.refused === true;
    // Once a send may have reached the customer, the row stays "may have gone out" whatever later tries return.
    const maybeSentAt = rr.maybeSentAt ?? (refused ? null : now);
    const error: Failure = providerOptOut
      ? "provider_opted_out"
      : !refused || maybeSentAt
        ? "outcome_unknown"
        : "provider_rejected";
    const sends = rr.sendAttempts + 1;
    if (rr.channel === "email" && err?.retryable === true && sends < EMAIL_MAX_SENDS) {
      const asked = typeof err.retryAfterMs === "number" && err.retryAfterMs > 0 ? err.retryAfterMs : 0;
      const wait = Math.max(asked, EMAIL_RETRY_BASE_MS * 2 ** (sends - 1));
      const next = nextSendTime(new Date(now.getTime() + wait), l.timezone);
      const keyValid = !maybeSentAt || next.getTime() <= maybeSentAt.getTime() + EMAIL_RETRY_WINDOW_MS;
      if (next.getTime() <= s.staleAt && keyValid) {
        await recordOutcome(db, rr.id, now, async (tx) => {
          await tx
            .update(reviewRequests)
            .set({ status: "scheduled", sentAt: null, scheduledFor: next, maybeSentAt })
            .where(eq(reviewRequests.id, rr.id));
          await audit(
            tx,
            l.id,
            rr.id,
            "retry_scheduled",
            `attempt=${rr.attempt};channel=email;error=${error};send=${sends}`,
          );
        });
        return "retrying";
      }
    }
    await recordOutcome(db, rr.id, now, async (tx) => {
      // FR-9 dates a request up to its last possible send (askedRecently). failRequest clears sent_at, and this send
      // ran after the row was due, so when it may have gone out its time is kept in scheduled_for (audit A-82-1).
      if (maybeSentAt)
        await tx
          .update(reviewRequests)
          .set(refused ? { maybeSentAt } : { maybeSentAt, scheduledFor: now })
          .where(eq(reviewRequests.id, rr.id));
      await failRequest(tx, rr, l.id, error);
      if (providerOptOut) {
        await optOut(tx, l.id, "sms", s.address, "provider_sms");
        return;
      }
      // FR-6: a request whose text was refused goes by email instead (one channel per request, never both).
      if (
        refused &&
        rr.channel === "sms" &&
        rr.attempt === 1 &&
        c.normalizedEmail &&
        !(await isOptedOut(tx, l.id, c))
      ) {
        const [fb] = await tx
          .insert(reviewRequests)
          .values({ visitId: rr.visitId, scheduledFor: now, channel: "email", attempt: 1 })
          .onConflictDoNothing()
          .returning({ id: reviewRequests.id });
        if (fb) await audit(tx, l.id, fb.id, "scheduled", "attempt=1;channel=email;fallback=sms_failed");
      }
    });
    return "failed";
  }
  // The row stays sent, so the "already recorded" check is the one sent audit row a row ever gets (an email retried
  // through an outage gets it only for the send that went through).
  await recordOutcome(
    db,
    rr.id,
    now,
    async (tx) => {
      await tx
        .update(reviewRequests)
        .set({ providerMessageId: messageId || null })
        .where(eq(reviewRequests.id, rr.id));
      await audit(tx, l.id, rr.id, "sent", `attempt=${rr.attempt};channel=${rr.channel}`);
    },
    async (tx) =>
      (
        await tx
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.locationId, l.id),
              eq(auditLog.entity, "review_request"),
              eq(auditLog.entityId, rr.id),
              eq(auditLog.action, "sent"),
            ),
          )
          .limit(1)
      ).length > 0,
  );
  // A receipt can beat the line above that records the message ID (audit O-66-1); apply any that did. Never changes
  // the outcome of this send.
  if (messageId)
    await applyPendingReceipts(rr.channel, messageId, now, db).catch((e) =>
      console.error(
        `send_due_requests: pending receipts not applied id=${rr.id} error=${e instanceof Error ? e.name : "unknown"}`,
      ),
    );
  return "sent";
}

// FR-6 (owner decision 2026-11-27, audit O-66-4): Twilio took the text but later reported it "undelivered" or
// "failed" (status callback, /api/sms/status). That counts as the text failing, so the request goes by email instead,
// exactly as for a text Twilio refused at send time (deliver above):
// - the text's row becomes failed (sent_at cleared; not "may have reached the customer", so FR-9 does not count it);
// - attempt 1 only, the customer has an email and is not opted out, and the visit has no reminder yet: one email
//   request is scheduled now (unique (visit, channel, attempt): never twice);
// - Twilio 21610 (the customer had texted STOP to Twilio): the opt-out is recorded and nothing else is sent.
// A text that was clicked or confirmed delivered reached the customer, so a later failure status is ignored. Repeated
// callbacks change nothing: only a row still "sent" is failed. Results are codes only, never numbers or text.
export const CARRIER_FAILURE_STATUSES = ["undelivered", "failed"] as const;
const TWILIO_OPTED_OUT = 21610;

export async function recordSmsFailure(
  messageSid: string,
  errorCode: number | null,
  now: Date = new Date(),
  db: Db = defaultDb,
): Promise<"failed" | "ignored" | "unknown"> {
  const sid = messageSid.trim();
  if (!sid || sid.length > 200) return "unknown";
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ id: reviewRequests.id, locationId: visits.locationId })
      .from(reviewRequests)
      .innerJoin(visits, eq(visits.id, reviewRequests.visitId))
      .where(and(eq(reviewRequests.providerMessageId, sid), eq(reviewRequests.channel, "sms")))
      .limit(1);
    if (!found) return "unknown";
    await lockLocation(tx, found.locationId);
    const delivered = tx
      .select({ x: sql`1` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entity, "review_request"),
          eq(auditLog.entityId, reviewRequests.id),
          eq(auditLog.action, DELIVERED_ACTION),
        ),
      );
    const [rr] = await tx
      .update(reviewRequests)
      .set({ status: "failed", sentAt: null })
      .where(
        and(
          eq(reviewRequests.id, found.id),
          eq(reviewRequests.status, "sent"),
          isNull(reviewRequests.clickedAt),
          notExists(delivered),
        ),
      )
      .returning();
    if (!rr) return "ignored";
    const optedOut = errorCode === TWILIO_OPTED_OUT;
    const error: Failure = optedOut ? "provider_opted_out" : "carrier_undelivered";
    await audit(tx, found.locationId, rr.id, "failed", `attempt=${rr.attempt};channel=sms;error=${error}`);

    const [c] = await tx
      .select()
      .from(customers)
      .innerJoin(visits, eq(visits.customerId, customers.id))
      .where(eq(visits.id, rr.visitId));
    const customer = c?.customers;
    if (optedOut) {
      if (customer?.normalizedPhone)
        await optOut(tx, found.locationId, "sms", customer.normalizedPhone, "provider_sms");
      return "failed";
    }
    if (rr.attempt !== 1 || !customer?.normalizedEmail || (await isOptedOut(tx, found.locationId, customer)))
      return "failed";
    const [reminder] = await tx
      .select({ id: reviewRequests.id })
      .from(reviewRequests)
      .where(and(eq(reviewRequests.visitId, rr.visitId), eq(reviewRequests.attempt, 2)))
      .limit(1);
    if (reminder) return "failed";
    const [fb] = await tx
      .insert(reviewRequests)
      .values({ visitId: rr.visitId, scheduledFor: now, channel: "email", attempt: 1 })
      .onConflictDoNothing()
      .returning({ id: reviewRequests.id });
    if (fb) await audit(tx, found.locationId, fb.id, "scheduled", "attempt=1;channel=email;fallback=sms_undelivered");
    return "failed";
  });
}

// Delivery receipts from /api/sms/status and /api/email/events (FR-17 "delivered", FR-6 carrier failures). Twilio
// does not retry status callbacks, and a receipt can arrive before deliver() has recorded the message ID (audit
// O-66-1), so a receipt that matches no request is kept in pending_receipts (IDs and status only) and applied by
// deliver() once it records the ID. Each side writes first and reads second, so whichever runs last sees the other;
// applying a receipt twice changes nothing (recordDelivery and recordSmsFailure are idempotent). Receipts for
// messages that are not review requests (owner emails, opt-out confirmations) stay pending until the purge job
// deletes them after PENDING_RECEIPT_MAX_AGE_MS.
export type ReceiptStatus = "delivered" | (typeof CARRIER_FAILURE_STATUSES)[number];
export const PENDING_RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function applyReceipt(
  channel: DeliveryChannel,
  id: string,
  status: ReceiptStatus,
  errorCode: number | null,
  now: Date,
  db: Db,
) {
  if (status === "delivered") return recordDelivery(channel, id, db);
  return channel === "sms" ? recordSmsFailure(id, errorCode, now, db) : Promise.resolve("unknown" as const);
}

export async function handleReceipt(
  channel: DeliveryChannel,
  providerMessageId: string,
  status: ReceiptStatus,
  errorCode: number | null,
  db: Db = defaultDb,
): Promise<"recorded" | "duplicate" | "failed" | "ignored" | "pending" | "unknown"> {
  const id = providerMessageId.trim();
  if (!id || id.length > 200) return "unknown";
  const now = new Date();
  const first = await applyReceipt(channel, id, status, errorCode, now, db);
  if (first !== "unknown") return first;
  await db.insert(pendingReceipts).values({ channel, providerMessageId: id, status, errorCode }).onConflictDoNothing();
  const again = await applyReceipt(channel, id, status, errorCode, now, db);
  if (again === "unknown") return "pending";
  await db
    .delete(pendingReceipts)
    .where(
      and(
        eq(pendingReceipts.channel, channel),
        eq(pendingReceipts.providerMessageId, id),
        eq(pendingReceipts.status, status),
      ),
    );
  return again;
}

export async function applyPendingReceipts(
  channel: DeliveryChannel,
  providerMessageId: string,
  now: Date = new Date(),
  db: Db = defaultDb,
) {
  const waiting = await db
    .select()
    .from(pendingReceipts)
    .where(and(eq(pendingReceipts.channel, channel), eq(pendingReceipts.providerMessageId, providerMessageId)));
  for (const r of waiting) {
    await applyReceipt(channel, providerMessageId, r.status as ReceiptStatus, r.errorCode, now, db);
    await db.delete(pendingReceipts).where(eq(pendingReceipts.id, r.id));
  }
  return waiting.length;
}

// Daily purge job step: receipts still unmatched after a day are for messages that are not review requests.
export async function purgePendingReceipts(now: Date = new Date(), db: Db = defaultDb) {
  const gone = await db
    .delete(pendingReceipts)
    .where(lt(pendingReceipts.receivedAt, new Date(now.getTime() - PENDING_RECEIPT_MAX_AGE_MS)))
    .returning({ id: pendingReceipts.id });
  return gone.length;
}

export async function runReviewRequestJobs(
  providers: Providers,
  o: RequestJobOptions & { config?: SendConfig } = {},
  db: Db = defaultDb,
) {
  const config = o.config ?? sendConfigFromEnv(); // fail before scheduling anything if sending is misconfigured
  const scheduled = await scheduleReviewRequests(o, db);
  const reminders = await scheduleReminders(o, db);
  const sent = await sendDueRequests(providers, { ...o, config }, db);
  return { scheduled, reminders, sent };
}

// A message whose link may be in the customer's hands: it went out, or its send failed with an unknown outcome
// (timeout, lost connection, ambiguous 5xx), which clears sent_at but may still have delivered it (F-12-4, #43).
// Its link must keep working (FR-7, Flow 2: the review link goes through our redirect). A definite refusal and a
// request never sent stay 404.
const linkMayHaveGoneOut = or(
  isNotNull(reviewRequests.sentAt),
  and(eq(reviewRequests.status, "failed"), eq(reviewRequests.outcomeUnknown, true)),
  isNotNull(reviewRequests.maybeSentAt), // an email waiting to be retried, or skipped since (F-12-2)
);

// The redirect link (FR-7): records the first click on a message that may have gone out and returns the location's
// review link.
export async function recordClick(requestId: string, now: Date = new Date(), db: Db = defaultDb) {
  if (!z.uuid().safeParse(requestId).success) return null;
  const [hit] = await db
    .update(reviewRequests)
    .set({ clickedAt: sql`coalesce(${reviewRequests.clickedAt}, ${now.toISOString()}::timestamptz)` })
    .where(and(eq(reviewRequests.id, requestId), linkMayHaveGoneOut))
    .returning({ visitId: reviewRequests.visitId });
  return hit ? reviewLinkForVisit(hit.visitId, db) : null;
}

// Same lookup without recording a click (HEAD requests, link scanners that only probe).
export async function reviewLinkFor(requestId: string, db: Db = defaultDb) {
  if (!z.uuid().safeParse(requestId).success) return null;
  const [rr] = await db
    .select({ visitId: reviewRequests.visitId })
    .from(reviewRequests)
    .where(and(eq(reviewRequests.id, requestId), linkMayHaveGoneOut));
  return rr ? reviewLinkForVisit(rr.visitId, db) : null;
}

async function reviewLinkForVisit(visitId: string, db: Db) {
  const [l] = await db
    .select({ link: locations.reviewLink })
    .from(visits)
    .innerJoin(locations, eq(locations.id, visits.locationId))
    .where(eq(visits.id, visitId));
  return l?.link ?? null;
}
