// The one opt-out confirmation text (SPEC FR-8, Flow 2 step 4), made durable (audit F-9-2). The inbound webhook
// records it in optout_confirmations in the opt-out's own transaction and sends it at once; this job sends or retries
// whatever that first attempt did not finish. FCC 47 CFR 64.1200(a)(10) allows one confirmation-only text, presumed
// fine within 5 minutes of the request, so nothing is sent after CONFIRM_WINDOW_SECONDS and never twice:
// - every attempt is claimed by a guarded update (status and attempt count unchanged) before the provider is called;
// - an attempt whose outcome is unknown (timeout, lost connection, 5xx: Twilio has no idempotency key) is resolved by
//   asking Twilio whether it already took a text from our number to the customer since the opt-out. Nothing else is
//   sent to a suppressed number, so any such text is the confirmation.
// Results are counts only, never phone numbers or message text.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { businesses, locations, optOutConfirmations, suppressionList } from "../db/schema";
import type { SmsProvider } from "../sms/provider";

export const CONFIRM_WINDOW_SECONDS = 300;
// An inline webhook attempt takes at most ~32 s (3 tries x 10 s timeout plus backoff). A "sending" row is checked only
// 90 s after its last attempt started, so Twilio's message list has had about a minute after that attempt ended to
// show a text it took before a "not found" lets us resend. A timed-out send never returns a message SID, so the list
// is the only record to check. Resends still fit the 5-minute window: about 100 s, 130 s and 190 s after the opt-out.
export const STALE_SECONDS = 90;

export interface ConfirmationSms extends SmsProvider {
  // True when the provider already took a text from `from` to `to` created at or after `since`.
  sentSince(from: string, to: string, since: Date): Promise<boolean>;
}

export const confirmationText = (businessName: string | null | undefined) =>
  `You're unsubscribed from ${businessName ? `${businessName} texts` : "these texts"}. No more messages will be sent.`;

const c = optOutConfirmations;
const setStatus = (id: string, status: "sent" | "pending" | "provider", db: Db) =>
  db.update(c).set({ status }).where(eq(c.id, id));

// Records the outcome of a send that threw: the provider has the recipient opted out and confirmed it itself
// (21610), refused the text (safe to resend), or left the outcome unknown (stays "sending" for the job to check).
export async function recordSendError(id: string, e: unknown, db: Db = defaultDb) {
  const err = e as { recipientOptedOut?: unknown; refused?: unknown } | null;
  if (err?.recipientOptedOut === true) return void (await setStatus(id, "provider", db));
  if (err?.refused === true) await setStatus(id, "pending", db);
}

export async function sendPendingConfirmations(sms: ConfirmationSms, db: Db = defaultDb) {
  const out = { sent: 0, alreadySent: 0, provider: 0, expired: 0, failed: 0, open: 0 };
  const inWindow = sql`${c.createdAt} > now() - make_interval(secs => ${CONFIRM_WINDOW_SECONDS})`;
  const open = inArray(c.status, ["sending", "pending"]);

  out.expired = (
    await db
      .update(c)
      .set({ status: "expired" })
      .where(and(open, sql`not (${inWindow})`))
      .returning({ id: c.id })
  ).length;

  const rows = await db
    .select({
      id: c.id,
      status: c.status,
      attempts: c.attempts,
      createdAt: c.createdAt,
      from: c.fromNumber,
      to: suppressionList.address,
      businessName: businesses.name,
      ready: sql<boolean>`${c.status} = 'pending' or ${c.lastAttemptAt} < now() - make_interval(secs => ${STALE_SECONDS})`,
    })
    .from(c)
    .innerJoin(suppressionList, eq(suppressionList.id, c.suppressionId))
    .leftJoin(locations, eq(locations.id, c.locationId))
    .leftJoin(businesses, eq(businesses.id, locations.businessId))
    .where(and(open, inWindow));

  for (const r of rows) {
    if (!r.ready) {
      out.open++; // the webhook's attempt may still be in flight
      continue;
    }
    // Claim: only one run gets past this for a given attempt.
    const [claimed] = await db
      .update(c)
      .set({ status: "sending", attempts: sql`${c.attempts} + 1`, lastAttemptAt: sql`now()` })
      .where(and(eq(c.id, r.id), eq(c.status, r.status), eq(c.attempts, r.attempts), inWindow))
      .returning({ id: c.id });
    if (!claimed) continue;
    if (r.status === "sending") {
      // A failed lookup says nothing about the earlier attempt, so the row stays "sending" (outcome unknown) and the
      // next run looks again. It must not go through recordSendError: a 429 or 503 from the message list is a
      // TwilioSendError with refused: true, which would mark the row pending, and a pending row is resent without a
      // lookup (audit F-72-1).
      const found = await sms.sentSince(r.from, r.to, r.createdAt).catch(() => null);
      if (found === null) {
        out.failed++;
        out.open++;
        continue;
      }
      if (found) {
        await setStatus(r.id, "sent", db);
        out.alreadySent++;
        continue;
      }
    }
    try {
      await sms.send(r.from, r.to, confirmationText(r.businessName));
      await setStatus(r.id, "sent", db);
      out.sent++;
    } catch (e) {
      await recordSendError(r.id, e, db);
      if ((e as { recipientOptedOut?: unknown } | null)?.recipientOptedOut === true) out.provider++;
      else {
        out.failed++;
        out.open++;
      }
    }
  }
  return out;
}
