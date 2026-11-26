// Posting owner-approved replies to Google (SPEC FR-15, FR-14 "nothing posts without approval", Flow 3 step 4).
// Only a draft the owner approved (status approved, approved_at set by src/inbox/inbox.ts) is ever posted, and only
// its final text (the owner's edit, or the draft they approved unchanged). Nothing is approved here.
// - Locations: a Google location ID, an active unrevoked token and a business that is not offboarded (FR-20), the
//   same targets the poller reads (src/reviews/poll.ts).
// - Idempotent (SPEC Reliability): each draft is locked (FOR UPDATE SKIP LOCKED) and re-checked as approved and
//   unposted before Google is called, so overlapping runs never post the same draft twice. Google keeps one reply per
//   review and a repeated post replaces it with the same text, so a crash after Google stored the reply but before
//   we marked the draft posted is repaired by the next run. one_posted_reply_per_review guards the database side.
// - A review that already has a reply on Google (has_reply, refreshed by every poll) is not posted: posting would
//   replace a reply the owner wrote on Google themselves. The draft is marked failed (already_replied). This is the
//   default until the owner decides SPEC D-6.
// - Failures: Google refusing this reply for good (rejected, not_found, invalid_reply, invalid_review) marks the
//   draft failed. Anything a later run or a reconnect can fix (timeouts, 5xx, revoked access, no access, a token we
//   cannot read) leaves it approved for the next run; a revoked grant also marks the token refresh_failed, like a poll.
// Audit rows carry IDs and short codes only, never reply text, review text, names or tokens.
import { and, asc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { auditLog, businesses, locations, oauthTokens, replyDrafts, reviews } from "../db/schema";
import { GoogleReviewsError, type ReplyPoster } from "../google/businessProfile";
import { decryptRefreshToken } from "../google/tokenCrypto";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const ACTOR = "system:reply_post";
export const POST_BATCH = 100; // per run; the rest wait 15 minutes for the next one
// Google refused this reply itself: retrying cannot help, so the draft leaves the queue.
const PERMANENT = new Set(["rejected", "not_found", "invalid_reply", "invalid_review"]);

export type PostDeps = { poster: ReplyPoster; tokenSecret: string; now?: Date };
export type PostOutcome = { draftId: string; code: string };
export type PostResult = {
  posted: number;
  failed: PostOutcome[]; // marked failed: will not be posted
  waiting: PostOutcome[]; // still approved: the next run tries again
};

export async function postApprovedReplies(deps: PostDeps, db: Db = defaultDb): Promise<PostResult> {
  const now = deps.now ?? new Date();
  const due = await db
    .select({
      draftId: replyDrafts.id,
      locationId: replyDrafts.locationId,
      googleLocationId: locations.googleLocationId,
      tokenId: oauthTokens.id,
      encrypted: oauthTokens.encryptedRefreshToken,
    })
    .from(replyDrafts)
    .innerJoin(locations, eq(locations.id, replyDrafts.locationId))
    .innerJoin(businesses, eq(businesses.id, locations.businessId))
    .innerJoin(oauthTokens, eq(oauthTokens.locationId, locations.id))
    .where(
      and(
        eq(replyDrafts.status, "approved"),
        isNotNull(replyDrafts.approvedAt),
        isNull(replyDrafts.postedAt),
        isNotNull(locations.googleLocationId),
        eq(oauthTokens.status, "active"),
        isNull(oauthTokens.revokedAt),
        ne(businesses.status, "offboarded"),
      ),
    )
    .orderBy(asc(replyDrafts.approvedAt))
    .limit(POST_BATCH);

  const result: PostResult = { posted: 0, failed: [], waiting: [] };
  const tokens = new Map<string, string | null>(); // decrypted once per location per run
  const revoked = new Set<string>(); // locations whose grant Google refused during this run

  for (const d of due) {
    const audit = (tx: Db | Tx, action: string, detail: string | null) =>
      tx.insert(auditLog).values({
        locationId: d.locationId,
        entity: "reply_draft",
        entityId: d.draftId,
        action,
        actor: ACTOR,
        detail,
        at: now,
      });

    if (revoked.has(d.locationId)) {
      result.waiting.push({ draftId: d.draftId, code: "token_revoked" });
      continue;
    }
    if (!tokens.has(d.locationId))
      tokens.set(d.locationId, decryptRefreshToken(d.encrypted, d.locationId, deps.tokenSecret));
    const refreshToken = tokens.get(d.locationId);
    if (!refreshToken) {
      // Wrong GOOGLE_TOKEN_SECRET or a damaged row: fix the configuration; the draft stays approved.
      await audit(db, "reply_post_failed", "code=token_unreadable");
      result.waiting.push({ draftId: d.draftId, code: "token_unreadable" });
      continue;
    }

    await db.transaction(async (tx) => {
      // Re-check under the lock: still approved and unposted. A row another run holds is skipped, not waited for.
      const [row] = await tx
        .select({
          finalText: replyDrafts.finalText,
          draftText: replyDrafts.draftText,
          googleReviewId: reviews.googleReviewId,
          hasReply: reviews.hasReply,
        })
        .from(replyDrafts)
        .innerJoin(reviews, and(eq(reviews.id, replyDrafts.reviewId), eq(reviews.locationId, replyDrafts.locationId)))
        .where(
          and(
            eq(replyDrafts.id, d.draftId),
            eq(replyDrafts.status, "approved"),
            isNotNull(replyDrafts.approvedAt),
            isNull(replyDrafts.postedAt),
          ),
        )
        .for("update", { of: replyDrafts, skipLocked: true });
      if (!row) return;

      const fail = async (code: string) => {
        await tx.update(replyDrafts).set({ status: "failed" }).where(eq(replyDrafts.id, d.draftId));
        await audit(tx, "reply_post_failed", `code=${code}`);
        result.failed.push({ draftId: d.draftId, code });
      };

      if (row.hasReply) return fail("already_replied");

      try {
        await deps.poster.postReply(
          { googleLocationId: d.googleLocationId!, refreshToken },
          row.googleReviewId,
          row.finalText ?? row.draftText,
        );
      } catch (e) {
        const code = e instanceof GoogleReviewsError ? e.code : "error";
        if (PERMANENT.has(code)) return fail(code);
        if (code === "token_revoked") {
          revoked.add(d.locationId);
          await tx
            .update(oauthTokens)
            .set({ status: "refresh_failed" })
            .where(and(eq(oauthTokens.id, d.tokenId), eq(oauthTokens.status, "active")));
        }
        await audit(tx, "reply_post_failed", `code=${code}`);
        result.waiting.push({ draftId: d.draftId, code });
        return;
      }

      await tx.update(replyDrafts).set({ status: "posted", postedAt: now }).where(eq(replyDrafts.id, d.draftId));
      await audit(tx, "reply_posted", null);
      result.posted++;
    });
  }
  return result;
}
