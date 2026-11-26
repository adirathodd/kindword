// Offboarded-business retention (SPEC Security and privacy, "Retention: ... everything for a business within 30 days
// of offboarding"). Deletes every business that has been offboarded for 29 days or more: one day before the limit, so
// a daily run that comes a day late still deletes in time (same margin as the review purge, src/reviews/purge.ts).
//
// Deleting the business row deletes everything under it by cascade: locations, customers, visits, review requests,
// reviews, reply drafts, owner sessions, the owner account and its tokens and sessions, Google tokens, sheet sources,
// consent attestations, hosted opt-in records and location-level opt-outs.
//
// What is kept, on purpose:
// - Platform-wide opt-outs (suppression_list rows with no location): an opt-out must keep blocking that phone or email
//   for every other business (FR-8).
// - audit_log: IDs and actions only (FR-19), with no foreign key, so it survives. One row per deleted business.
//
// offboarded_at is set by a database trigger when status becomes offboarded and cleared if it changes back
// (migration 0015), so a business switched back to live before the deadline is never deleted.
//
// Not done here: revoking Google access. SPEC says tokens are revoked on offboarding (FR-20), which happens at
// offboarding time, not 30 days later. Deleting the business deletes our encrypted copy of the token.
import { and, eq, inArray, lte } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { auditLog, businesses } from "../db/schema";

export const OFFBOARDED_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTOR = "system:retention";

export type BusinessPurgeResult = { businesses: number; cutoff: Date };

export async function purgeOffboardedBusinesses(
  opts: { now?: Date; marginMs?: number } = {},
  db: Db = defaultDb,
): Promise<BusinessPurgeResult> {
  const now = opts.now ?? new Date();
  const marginMs = opts.marginMs ?? DAY_MS;
  if (!Number.isFinite(marginMs) || marginMs < 0 || marginMs >= OFFBOARDED_RETENTION_DAYS * DAY_MS)
    throw new Error("purgeOffboardedBusinesses: marginMs must be between 0 and 30 days");
  const cutoff = new Date(now.getTime() - OFFBOARDED_RETENTION_DAYS * DAY_MS + marginMs);

  const due = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(and(eq(businesses.status, "offboarded"), lte(businesses.offboardedAt, cutoff)));

  let deleted = 0;
  // One business per transaction: a large business never holds locks on the others, and a failure stops only it.
  for (const { id } of due) {
    const gone = await db.transaction(async (tx) => {
      // Re-checked under the row lock: a business switched back from offboarded since the query is kept.
      const [b] = await tx
        .select({ id: businesses.id })
        .from(businesses)
        .where(and(eq(businesses.id, id), eq(businesses.status, "offboarded"), lte(businesses.offboardedAt, cutoff)))
        .for("update");
      if (!b) return false;
      await tx.delete(businesses).where(inArray(businesses.id, [b.id]));
      await tx.insert(auditLog).values({
        entity: "business",
        entityId: b.id,
        action: "purged",
        actor: ACTOR,
        detail: `reason=offboarded_${OFFBOARDED_RETENTION_DAYS}d`,
      });
      return true;
    });
    if (gone) deleted++;
  }
  return { businesses: deleted, cutoff };
}
