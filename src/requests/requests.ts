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
import { pickLanguage, reviewEmail, smsBody, type Attempt } from "./messages";
import { inSendWindow, nextSendTime } from "./window";

type Channel = (typeof channel.enumValues)[number];
type SkipReason = (typeof skipReason.enumValues)[number];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Customer = typeof customers.$inferSelect;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BATCH = 200;

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
        ),
        or(
          eq(customers.id, c.id),
          c.normalizedPhone ? eq(customers.normalizedPhone, c.normalizedPhone) : undefined,
          c.normalizedEmail ? eq(customers.normalizedEmail, c.normalizedEmail) : undefined,
        ),
        gt(sql`coalesce(${reviewRequests.sentAt}, ${reviewRequests.scheduledFor})`, new Date(at.getTime() - dedupMs)),
        lt(sql`coalesce(${reviewRequests.sentAt}, ${reviewRequests.scheduledFor})`, new Date(at.getTime() + dedupMs)),
      ),
    )
    .limit(1);
  return !!hit;
}

export type ScheduleResult = { scheduled: number; skipped: Partial<Record<SkipReason, number>> };

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
    .where(notExists(hasRequest))
    .orderBy(asc(visits.visitAt))
    .limit(BATCH);

  for (const p of pending) {
    const outcome = await db.transaction(async (tx) => {
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
    if (outcome === null) continue;
    if (outcome === "scheduled") result.scheduled++;
    else result.skipped[outcome] = (result.skipped[outcome] ?? 0) + 1;
  }
  return result;
}

// Creates the one reminder (attempt 2) for every request sent at least reminderDelayMs ago whose link nobody
// clicked, on the same channel. Never a second reminder, never more than 2 messages per job (FR-5).
export async function scheduleReminders(o: RequestJobOptions = {}, db: Db = defaultDb): Promise<{ scheduled: number }> {
  const { now, reminderDelayMs } = opts(o);
  const sibling = db
    .select({ x: sql`1` })
    .from(sql`review_requests r2`)
    .where(sql`r2.visit_id = ${reviewRequests.visitId} and (r2.attempt = 2 or r2.clicked_at is not null)`);
  const due = await db
    .select({ id: reviewRequests.id, visitId: reviewRequests.visitId, locationId: visits.locationId })
    .from(reviewRequests)
    .innerJoin(visits, eq(visits.id, reviewRequests.visitId))
    .where(
      and(
        eq(reviewRequests.attempt, 1),
        eq(reviewRequests.status, "sent"),
        lte(reviewRequests.sentAt, new Date(now.getTime() - reminderDelayMs)),
        notExists(sibling),
      ),
    )
    .orderBy(asc(reviewRequests.sentAt))
    .limit(BATCH);

  let scheduled = 0;
  for (const d of due) {
    const id = await db.transaction(async (tx) => {
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
    if (id) scheduled++;
  }
  return { scheduled };
}

export type SendResult = {
  sent: number;
  failed: number;
  deferred: number; // outside the window; moved to the next 9 a.m.
  waiting: number; // business not live, or no texting number yet; left as is until it is or the row goes stale
  skipped: Partial<Record<SkipReason, number>>;
};

type Claimed = {
  rr: typeof reviewRequests.$inferSelect;
  customer: Customer;
  location: typeof locations.$inferSelect;
  businessName: string;
  address: string;
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
  const result: SendResult = { sent: 0, failed: 0, deferred: 0, waiting: 0, skipped: {} };
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
      sql`case when ${businesses.status} = 'live' and (${reviewRequests.channel} = 'email' or ${locations.smsNumber} is not null) then 0 else 1 end`,
      asc(reviewRequests.scheduledFor),
    )
    .limit(BATCH);

  for (const { id } of due) {
    const step = await db.transaction(async (tx): Promise<Claimed | "deferred" | "waiting" | SkipReason | null> => {
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
      if (now.getTime() > staleAt) return skip("stale");
      if (b.status !== "live") return "waiting"; // onboarding, paused or offboarded: nothing goes out (FR-20)
      if (rr.channel === "sms" && !l.smsNumber) return "waiting"; // 10DLC not approved yet
      const address = rr.channel === "sms" ? c.normalizedPhone : c.normalizedEmail;
      if (!address) return skip("no_consent"); // customer rows are never edited by imports, so not expected
      if (!inSendWindow(now, l.timezone)) {
        const next = nextSendTime(now, l.timezone);
        if (next.getTime() > staleAt) return skip("stale");
        await tx.update(reviewRequests).set({ scheduledFor: next }).where(eq(reviewRequests.id, rr.id));
        return "deferred";
      }
      await tx.update(reviewRequests).set({ status: "sent", sentAt: now }).where(eq(reviewRequests.id, rr.id));
      return { rr, customer: c, location: l, businessName: b.name, address };
    });

    if (step === null) continue;
    if (step === "deferred" || step === "waiting") {
      result[step]++;
      continue;
    }
    if (typeof step === "string") {
      result.skipped[step] = (result.skipped[step] ?? 0) + 1;
      continue;
    }
    if (await deliver(providers, cfg, step, now, db)) result.sent++;
    else result.failed++;
  }
  return result;
}

async function deliver(providers: Providers, cfg: SendConfig, s: Claimed, now: Date, db: Db): Promise<boolean> {
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
    // Provider errors can echo the recipient, so only these two flags are read. Adapters retry transient errors
    // themselves. `refused`: the provider answered and did not take the message. Anything else (a timeout, a lost
    // connection, an ambiguous 5xx) may have gone out, so it never falls back to the other channel.
    const err = e as { refused?: unknown; recipientOptedOut?: unknown } | null;
    // Twilio 21610: the customer texted STOP to the provider. Record the opt-out here too (FR-8: suppression applies
    // to provider callbacks and future imports) and send nothing else.
    const providerOptOut = rr.channel === "sms" && err?.recipientOptedOut === true;
    const refused = providerOptOut || err?.refused === true;
    const error = providerOptOut ? "provider_opted_out" : refused ? "provider_rejected" : "outcome_unknown";
    await db.transaction(async (tx) => {
      await tx
        .update(reviewRequests)
        .set({ status: "failed", sentAt: null, outcomeUnknown: error === "outcome_unknown" })
        .where(eq(reviewRequests.id, rr.id));
      await audit(tx, l.id, rr.id, "failed", `attempt=${rr.attempt};channel=${rr.channel};error=${error}`);
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
    return false;
  }
  await db
    .update(reviewRequests)
    .set({ providerMessageId: messageId || null })
    .where(eq(reviewRequests.id, rr.id));
  await audit(db, l.id, rr.id, "sent", `attempt=${rr.attempt};channel=${rr.channel}`);
  return true;
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

// The redirect link (FR-7): records the first click on a sent message and returns the location's review link.
export async function recordClick(requestId: string, now: Date = new Date(), db: Db = defaultDb) {
  if (!z.uuid().safeParse(requestId).success) return null;
  const [hit] = await db
    .update(reviewRequests)
    .set({ clickedAt: sql`coalesce(${reviewRequests.clickedAt}, ${now.toISOString()}::timestamptz)` })
    .where(and(eq(reviewRequests.id, requestId), isNotNull(reviewRequests.sentAt)))
    .returning({ visitId: reviewRequests.visitId });
  return hit ? reviewLinkForVisit(hit.visitId, db) : null;
}

// Same lookup without recording a click (HEAD requests, link scanners that only probe).
export async function reviewLinkFor(requestId: string, db: Db = defaultDb) {
  if (!z.uuid().safeParse(requestId).success) return null;
  const [rr] = await db
    .select({ visitId: reviewRequests.visitId })
    .from(reviewRequests)
    .where(and(eq(reviewRequests.id, requestId), isNotNull(reviewRequests.sentAt)));
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
