// Google review polling (SPEC FR-11, Flow 3 step 1; FR-22 "refresh stored review IDs within 30 days"). For every
// location with a Google connection, read all of its reviews through the ReviewSource (src/google/businessProfile.ts)
// and store what Google returns:
// - A review we already hold is refreshed: rating, text, reviewer name and has_reply are overwritten with Google's
//   current values and fetched_at moves to now, which keeps it out of the 30-day purge (src/reviews/purge.ts).
// - A new review without a reply is inserted, ready for drafting (src/reviews/draft.ts).
// - A new review the business already answered on Google is not stored: nothing would use it, and we collect the
//   minimum (SPEC Security). If Google later shows the reply removed, the next run stores it like any new review.
// Every run reads every review, so a missed run is caught up by the next one (FR-11 "catching up on missed runs").
// No scheduler is chosen yet, so callers invoke it; run it every 15 minutes. It is idempotent: two runs at once store
// each review once (unique google_review_id) and audit each new review once.
// When Google says our access was revoked (invalid_grant), the location's token is marked refresh_failed and no
// longer polled until someone reconnects. Audit rows carry IDs and short codes only, never review text, reviewer
// names or tokens. Rating averages and review counts are never computed or stored.
import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { auditLog, businesses, locations, oauthTokens, reviews } from "../db/schema";
import { GoogleReviewsError, type GoogleReview, type ReviewSource } from "../google/businessProfile";
import { decryptRefreshToken } from "../google/tokenCrypto";

const ACTOR = "system:review_poll";
const BATCH = 200;
const MAX_TEXT = 10_000; // Google caps review text well below this; a guard against a malformed response
const MAX_NAME = 200;

export type PollDeps = { source: ReviewSource; tokenSecret: string; now?: Date };
export type PollResult = {
  locations: number; // locations read successfully
  newReviews: number;
  failed: { locationId: string; code: string }[];
};

const clip = (s: string | null, max: number) => (s === null ? null : s.slice(0, max));

export async function pollReviews(deps: PollDeps, db: Db = defaultDb): Promise<PollResult> {
  const now = deps.now ?? new Date();
  // Connected locations: a Google location ID and an active, unrevoked token. Offboarded businesses are never read
  // (FR-20: offboarding disconnects Google).
  const targets = await db
    .select({
      locationId: locations.id,
      googleLocationId: locations.googleLocationId,
      tokenId: oauthTokens.id,
      encrypted: oauthTokens.encryptedRefreshToken,
    })
    .from(locations)
    .innerJoin(businesses, eq(businesses.id, locations.businessId))
    .innerJoin(oauthTokens, eq(oauthTokens.locationId, locations.id))
    .where(
      and(
        isNotNull(locations.googleLocationId),
        eq(oauthTokens.status, "active"),
        isNull(oauthTokens.revokedAt),
        ne(businesses.status, "offboarded"),
      ),
    );

  const result: PollResult = { locations: 0, newReviews: 0, failed: [] };
  for (const t of targets) {
    const fail = async (code: string) => {
      result.failed.push({ locationId: t.locationId, code });
      await db.insert(auditLog).values({
        locationId: t.locationId,
        entity: "location",
        entityId: t.locationId,
        action: "review_poll_failed",
        actor: ACTOR,
        detail: `code=${code}`,
        at: now,
      });
    };
    const refreshToken = decryptRefreshToken(t.encrypted, t.locationId, deps.tokenSecret);
    if (!refreshToken) {
      await fail("token_unreadable"); // wrong GOOGLE_TOKEN_SECRET or a damaged row: fix the configuration
      continue;
    }
    let found: GoogleReview[];
    try {
      found = await deps.source.listReviews({ googleLocationId: t.googleLocationId!, refreshToken });
    } catch (e) {
      const code = e instanceof GoogleReviewsError ? e.code : "error";
      if (code === "token_revoked")
        await db
          .update(oauthTokens)
          .set({ status: "refresh_failed" })
          .where(and(eq(oauthTokens.id, t.tokenId), eq(oauthTokens.status, "active")));
      await fail(code);
      continue;
    }
    result.newReviews += await store(t.locationId, found, now, db);
    result.locations++;
    await db.insert(auditLog).values({
      locationId: t.locationId,
      entity: "location",
      entityId: t.locationId,
      action: "reviews_polled",
      actor: ACTOR,
      at: now,
    });
  }
  return result;
}

// Refreshes known reviews and inserts new unanswered ones. Returns how many were inserted.
async function store(locationId: string, found: GoogleReview[], now: Date, db: Db) {
  const seen = new Set<string>();
  const unique = found.filter((r) => !seen.has(r.reviewId) && seen.add(r.reviewId));
  let inserted = 0;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    inserted += await db.transaction(async (tx) => {
      const known = new Set(
        (
          await tx
            .select({ g: reviews.googleReviewId })
            .from(reviews)
            .where(
              and(
                eq(reviews.locationId, locationId),
                inArray(
                  reviews.googleReviewId,
                  batch.map((r) => r.reviewId),
                ),
              ),
            )
        ).map((r) => r.g),
      );
      const row = (r: GoogleReview) => ({
        rating: r.rating,
        text: clip(r.comment, MAX_TEXT),
        reviewerName: clip(r.reviewerName, MAX_NAME),
        postedAt: r.createdAt,
        hasReply: r.hasReply,
        fetchedAt: now,
      });

      for (const r of batch.filter((r) => known.has(r.reviewId)))
        await tx
          .update(reviews)
          .set(row(r))
          .where(and(eq(reviews.locationId, locationId), eq(reviews.googleReviewId, r.reviewId)));

      const fresh = batch.filter((r) => !known.has(r.reviewId) && !r.hasReply);
      if (!fresh.length) return 0;
      // ON CONFLICT DO NOTHING: a concurrent run inserted it first, or (never expected) another location holds the
      // same Google review ID. Either way this run neither overwrites it nor audits it.
      const added = await tx
        .insert(reviews)
        .values(fresh.map((r) => ({ locationId, googleReviewId: r.reviewId, ...row(r) })))
        .onConflictDoNothing({ target: reviews.googleReviewId })
        .returning({ id: reviews.id });
      if (added.length)
        await tx.insert(auditLog).values(
          added.map((a) => ({
            locationId,
            entity: "review",
            entityId: a.id,
            action: "fetched",
            actor: ACTOR,
            at: now,
          })),
        );
      return added.length;
    });
  }
  return inserted;
}
