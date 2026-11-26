// Posting owner-approved replies to Google (SPEC FR-15, FR-14 "nothing posts without approval", Flow 3 step 4).
// Only a draft the owner approved (status approved, approved_at set by src/inbox/inbox.ts) is ever posted, and only
// its final text (the owner's edit, or the draft they approved unchanged). Nothing is approved here.
// - Locations: a Google location ID, an active unrevoked token and a live business. Onboarding and paused businesses
//   wait (FR-24: nothing is sent before the operator switches the business to live; see D-7), offboarded ones are
//   never posted for (FR-20). The job skips locations whose review poll failed in the same run (skipLocationIds), and
//   the whole step when polling failed, so has_reply is never older than the last 15-minute poll.
// - Idempotent (SPEC Reliability): each draft is locked (FOR UPDATE SKIP LOCKED) and re-checked as approved and
//   unposted before Google is called, so overlapping runs never post the same draft twice. Google keeps one reply per
//   review and a repeated post replaces it with the same text. Before each call a reply_post_attempt audit row is
//   committed on its own, so if Google stored the reply but we never marked the draft posted (a crash, a timeout, a
//   database error), the next run sees the attempt, posts the same text again and marks the draft posted.
// - A review that already has a reply on Google (has_reply) and no attempt of ours is not posted: posting would replace
//   a reply the owner wrote on Google themselves. The draft is marked failed (already_replied). This is the default
//   until the owner decides SPEC D-6.
// - Failures: Google refusing this reply for good (rejected, invalid_reply, invalid_review) marks the draft failed.
//   Anything a later run or a reconnect can fix (timeouts, 5xx, revoked access, no access, a 404, a token we cannot
//   read, a database error) leaves it approved for the next run; a revoked grant also marks the token refresh_failed,
//   like a poll. A 404 stays approved because Google also answers 404 when access to the location is lost; a review
//   deleted on Google is purged within 30 days (FR-22), which deletes its draft.
// - Each run stops taking new drafts after POST_BUDGET_MS so a slow Google cannot run the job past its time limit.
// Audit rows carry IDs and short codes only, never reply text, review text, names or tokens.
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { auditLog, businesses, locations, oauthTokens, replyDrafts, reviews } from "../db/schema";
import { GoogleReviewsError, type ReplyPoster } from "../google/businessProfile";
import { decryptRefreshToken } from "../google/tokenCrypto";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const ACTOR = "system:reply_post";
export const POST_BATCH = 25; // per run; the rest wait 15 minutes for the next one
export const POST_BUDGET_MS = 60_000; // no new draft is started after this; one call can take about a minute more
// Google refused this reply itself: retrying cannot help, so the draft leaves the queue.
const PERMANENT = new Set(["rejected", "invalid_reply", "invalid_review"]);

export type PostDeps = {
  poster: ReplyPoster;
  tokenSecret: string;
  now?: Date;
  skipLocationIds?: ReadonlySet<string>; // locations whose poll failed in this run: has_reply may be stale
  clock?: () => number; // milliseconds, for the time budget
  budgetMs?: number;
};
export type PostOutcome = { draftId: string; code: string };
export type PostResult = {
  posted: number;
  failed: PostOutcome[]; // marked failed: will not be posted
  waiting: PostOutcome[]; // still approved: the next run tries again
};

export async function postApprovedReplies(deps: PostDeps, db: Db = defaultDb): Promise<PostResult> {
  const now = deps.now ?? new Date();
  const clock = deps.clock ?? Date.now;
  const deadline = clock() + (deps.budgetMs ?? POST_BUDGET_MS);
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
        eq(businesses.status, "live"),
      ),
    )
    .orderBy(asc(replyDrafts.approvedAt))
    .limit(POST_BATCH);

  const result: PostResult = { posted: 0, failed: [], waiting: [] };
  const tokens = new Map<string, string | null>(); // decrypted once per location per run
  const blocked = new Map<string, string>(); // location -> code, for the rest of this run (revoked or unreadable token)

  for (const d of due) {
    const wait = (code: string) => result.waiting.push({ draftId: d.draftId, code });
    if (clock() >= deadline) {
      wait("time_budget");
      continue;
    }
    if (deps.skipLocationIds?.has(d.locationId)) {
      wait("poll_failed");
      continue;
    }
    const block = blocked.get(d.locationId);
    if (block) {
      wait(block);
      continue;
    }
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

    if (!tokens.has(d.locationId))
      tokens.set(d.locationId, decryptRefreshToken(d.encrypted, d.locationId, deps.tokenSecret));
    const refreshToken = tokens.get(d.locationId);
    if (!refreshToken) {
      // Wrong GOOGLE_TOKEN_SECRET or a damaged row: fix the configuration. One audit row per location per run.
      await audit(db, "reply_post_failed", "code=token_unreadable");
      blocked.set(d.locationId, "token_unreadable");
      wait("token_unreadable");
      continue;
    }

    type Outcome = { kind: "posted" } | { kind: "failed" | "waiting"; code: string } | null;
    let outcome: Outcome;
    try {
      outcome = await db.transaction(async (tx): Promise<Outcome> => {
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
        if (!row) return null;

        const fail = async (code: string) => {
          await tx.update(replyDrafts).set({ status: "failed" }).where(eq(replyDrafts.id, d.draftId));
          await audit(tx, "reply_post_failed", `code=${code}`);
          return { kind: "failed", code } as const;
        };

        if (row.hasReply) {
          // Ours, if an earlier run reached Google and could not record it; otherwise the owner's own reply.
          const [attempt] = await tx
            .select({ id: auditLog.id })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.entity, "reply_draft"),
                eq(auditLog.entityId, d.draftId),
                eq(auditLog.action, "reply_post_attempt"),
              ),
            )
            .limit(1);
          if (!attempt) return fail("already_replied");
        }

        // Committed on its own connection before Google is called, so it survives a rollback of this transaction.
        await audit(db, "reply_post_attempt", null);
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
            blocked.set(d.locationId, "token_revoked");
            await tx
              .update(oauthTokens)
              .set({ status: "refresh_failed" })
              .where(and(eq(oauthTokens.id, d.tokenId), eq(oauthTokens.status, "active")));
          }
          await audit(tx, "reply_post_failed", `code=${code}`);
          return { kind: "waiting", code };
        }

        await tx.update(replyDrafts).set({ status: "posted", postedAt: now }).where(eq(replyDrafts.id, d.draftId));
        await audit(tx, "reply_posted", null);
        return { kind: "posted" };
      });
    } catch {
      // A database error: this draft stays approved (its attempt row lets the next run finish it), the rest go on.
      outcome = { kind: "waiting", code: "error" };
    }
    // Counted only after the transaction committed.
    if (outcome?.kind === "posted") result.posted++;
    else if (outcome?.kind === "failed") result.failed.push({ draftId: d.draftId, code: outcome.code });
    else if (outcome) wait(outcome.code);
  }
  return result;
}
