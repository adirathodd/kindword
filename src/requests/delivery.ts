// Delivery receipts for review requests and reminders (SPEC FR-17 and Flow 4: the monthly report counts messages
// "delivered"). Twilio's status callback (/api/sms/status) and Resend's webhook (/api/email/events) report each
// message the provider confirmed it delivered; this records one audit row for the matching review_requests row.
//
// - Matched by the provider's message ID (review_requests.provider_message_id) and channel. Receipts for anything
//   else we send (owner emails, opt-out confirmations) or for a message we no longer hold (a customer deleted under
//   the retention rule) match no row and are ignored.
// - Only a request we recorded as sent counts. A send whose outcome was unknown has no provider ID, so it never
//   matches, even if it did arrive.
// - Idempotent: providers repeat callbacks, so a second receipt for the same request writes nothing. A per-request
//   advisory lock stops two concurrent receipts from both writing.
// - The audit row holds IDs, the attempt and the channel only (FR-19): never the number, address or message text.
import { and, eq, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { auditLog, reviewRequests, visits } from "../db/schema";

export const DELIVERED_ACTION = "delivered";

export type DeliveryChannel = "sms" | "email";
export type DeliveryResult = "recorded" | "duplicate" | "unknown";

export async function recordDelivery(
  channel: DeliveryChannel,
  providerMessageId: string,
  db: Db = defaultDb,
): Promise<DeliveryResult> {
  const id = providerMessageId.trim();
  if (!id || id.length > 200) return "unknown";
  return db.transaction(async (tx) => {
    const [rr] = await tx
      .select({ id: reviewRequests.id, attempt: reviewRequests.attempt, locationId: visits.locationId })
      .from(reviewRequests)
      .innerJoin(visits, eq(visits.id, reviewRequests.visitId))
      .where(
        and(
          eq(reviewRequests.providerMessageId, id),
          eq(reviewRequests.channel, channel),
          eq(reviewRequests.status, "sent"),
        ),
      )
      .limit(1);
    if (!rr) return "unknown";
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`delivered:${rr.id}`}))`);
    const [seen] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(eq(auditLog.entity, "review_request"), eq(auditLog.entityId, rr.id), eq(auditLog.action, DELIVERED_ACTION)),
      )
      .limit(1);
    if (seen) return "duplicate";
    await tx.insert(auditLog).values({
      locationId: rr.locationId,
      entity: "review_request",
      entityId: rr.id,
      action: DELIVERED_ACTION,
      actor: channel === "sms" ? "provider:twilio" : "provider:resend",
      detail: `attempt=${rr.attempt};channel=${channel}`,
    });
    return "recorded";
  });
}
