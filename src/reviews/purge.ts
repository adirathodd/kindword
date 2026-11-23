// 30-day purge of Google review content (SPEC FR-22, Data model rules, Risks: "Review content kept past Google's
// 30-day limit"). Deletes every review not refreshed within the retention window, together with its reply drafts
// (text derived from the review). Audit rows carry IDs and counts only, never review text or reviewer names.
//
// "Refresh" is the review poller's job (FR-11): re-fetching a review from Google updates fetched_at, which keeps the
// row. This job removes whatever was not refreshed. No scheduler is chosen yet, so callers invoke it; run it at
// least daily (hourly is fine, it is idempotent).
import { inArray, lte } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { auditLog, replyDrafts, reviews } from "../db/schema";

export const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 500;

export type PurgeOptions = {
  now?: Date;
  // Purge this long before the 30-day limit so a run that comes up to a day late still removes content in time.
  marginMs?: number;
};

export type PurgeResult = { reviews: number; drafts: number; cutoff: Date };

export async function purgeExpiredReviews(opts: PurgeOptions = {}, db: Db = defaultDb): Promise<PurgeResult> {
  const now = opts.now ?? new Date();
  const marginMs = opts.marginMs ?? DAY_MS;
  if (!Number.isFinite(marginMs) || marginMs < 0 || marginMs >= RETENTION_DAYS * DAY_MS)
    throw new Error("purgeExpiredReviews: marginMs must be between 0 and 30 days");
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS + marginMs);

  let total = { reviews: 0, drafts: 0 };
  for (;;) {
    const n = await db.transaction(async (tx) => {
      // Lock the expired rows first. If a poller is refreshing one of them, we wait for it and Postgres re-checks
      // fetched_at, so a refreshed review and its drafts are kept.
      const expired = await tx
        .select({ id: reviews.id, locationId: reviews.locationId })
        .from(reviews)
        .where(lte(reviews.fetchedAt, cutoff))
        .orderBy(reviews.fetchedAt)
        .limit(BATCH)
        .for("update");
      if (!expired.length) return { reviews: 0, drafts: 0 };
      const ids = expired.map((r) => r.id);

      // Deleted explicitly (the FK would cascade) so each draft gets its own audit row.
      const drafts = await tx
        .delete(replyDrafts)
        .where(inArray(replyDrafts.reviewId, ids))
        .returning({ id: replyDrafts.id, reviewId: replyDrafts.reviewId, locationId: replyDrafts.locationId });
      await tx.delete(reviews).where(inArray(reviews.id, ids));

      const perReview = new Map<string, number>();
      for (const d of drafts) perReview.set(d.reviewId, (perReview.get(d.reviewId) ?? 0) + 1);
      await tx.insert(auditLog).values([
        ...expired.map((r) => ({
          locationId: r.locationId,
          entity: "review",
          entityId: r.id,
          action: "purged",
          actor: "system:purge",
          detail: `reason=retention_30d;drafts=${perReview.get(r.id) ?? 0}`,
        })),
        ...drafts.map((d) => ({
          locationId: d.locationId,
          entity: "reply_draft",
          entityId: d.id,
          action: "purged",
          actor: "system:purge",
          detail: "reason=retention_30d",
        })),
      ]);
      return { reviews: expired.length, drafts: drafts.length };
    });
    total = { reviews: total.reviews + n.reviews, drafts: total.drafts + n.drafts };
    if (n.reviews < BATCH) break;
  }
  return { ...total, cutoff };
}
