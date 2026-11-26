// Runs against the Postgres in DATABASE_URL. Fake data only; Google is a fake ReplyPoster.
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import { GoogleReviewsError, type ReplyPoster, type ReviewSourceLocation } from "../google/businessProfile";
import { encryptRefreshToken } from "../google/tokenCrypto";
import { postApprovedReplies } from "./post";

const SECRET = "test-only-google-token-secret-0123456789";
const NOW = new Date();

type PostCall = { location: ReviewSourceLocation; reviewId: string; comment: string };
class FakePoster implements ReplyPoster {
  calls: PostCall[] = [];
  // Per Google review ID: an error to throw (once, or always).
  constructor(private readonly failures = new Map<string, { error: Error; times?: number }>()) {}
  async postReply(location: ReviewSourceLocation, reviewId: string, comment: string) {
    this.calls.push({ location, reviewId, comment });
    const f = this.failures.get(reviewId);
    if (f && (f.times === undefined || f.times-- > 0)) throw f.error;
    await new Promise((r) => setTimeout(r, 5)); // lets an overlapping run reach the same draft
  }
  for = (reviewId: string) => this.calls.filter((c) => c.reviewId === reviewId);
}

const businessIds: string[] = [];
const locationIds: string[] = [];
let n = 0;
async function location(
  opts: {
    status?: (typeof s.businessStatus.enumValues)[number];
    token?: "active" | "revoked" | "none" | "garbled";
  } = {},
) {
  const [b] = await db
    .insert(s.businesses)
    .values({ name: "Post Test Plumbing", vertical: "plumbing", status: opts.status ?? "live" })
    .returning();
  businessIds.push(b.id);
  const googleLocationId = `accounts/88/locations/${Date.now()}${++n}`;
  const [l] = await db
    .insert(s.locations)
    .values({
      businessId: b.id,
      name: "Main",
      timezone: "America/New_York",
      reviewLink: "https://g.page/r/p",
      googleLocationId,
    })
    .returning();
  locationIds.push(l.id);
  const token = opts.token ?? "active";
  if (token !== "none")
    await db.insert(s.oauthTokens).values({
      locationId: l.id,
      encryptedRefreshToken: token === "garbled" ? "v1.garbled" : encryptRefreshToken(`rt-${l.id}`, l.id, SECRET),
      scopes: ["https://www.googleapis.com/auth/business.manage"],
      ...(token === "revoked" ? { revokedAt: NOW, status: "revoked" as const } : {}),
    });
  const [session] = await db
    .insert(s.ownerSessions)
    .values({
      locationId: l.id,
      ownerEmail: "owner@example.com",
      loginTokenHash: `post-test-${l.id}`,
      tokenExpiresAt: NOW,
    })
    .returning();
  return { locationId: l.id, googleLocationId, sessionId: session.id };
}

type Loc = Awaited<ReturnType<typeof location>>;
async function draft(
  l: Loc,
  opts: {
    status?: (typeof s.draftStatus.enumValues)[number];
    finalText?: string;
    hasReply?: boolean;
    googleReviewId?: string;
  } = {},
) {
  const googleReviewId = opts.googleReviewId ?? `R${Date.now()}x${++n}`;
  const [r] = await db
    .insert(s.reviews)
    .values({
      locationId: l.locationId,
      googleReviewId,
      rating: 5,
      text: "Fixed the leak fast.",
      reviewerName: "Sam Example",
      hasReply: opts.hasReply ?? false,
    })
    .returning();
  const status = opts.status ?? "approved";
  const approved = status === "approved" || status === "posted";
  const [d] = await db
    .insert(s.replyDrafts)
    .values({
      reviewId: r.id,
      locationId: l.locationId,
      draftText: "Thanks for choosing us!",
      finalText: approved ? (opts.finalText ?? "Thanks for choosing us!") : null,
      status,
      model: "test-model",
      promptVersion: 1,
      ...(approved ? { approvedSessionId: l.sessionId, approvedAt: NOW } : {}),
      ...(status === "posted" ? { postedAt: NOW } : {}),
    })
    .returning();
  return { draftId: d.id, reviewId: r.id, googleReviewId };
}

const draftRow = async (id: string) => (await db.select().from(s.replyDrafts).where(eq(s.replyDrafts.id, id)))[0];
const auditOf = (draftId: string) =>
  db
    .select()
    .from(s.auditLog)
    .where(and(eq(s.auditLog.entity, "reply_draft"), eq(s.auditLog.entityId, draftId)));
const run = (poster: ReplyPoster, extra: Partial<Parameters<typeof postApprovedReplies>[0]> = {}) =>
  postApprovedReplies({ poster, tokenSecret: SECRET, now: NOW, ...extra });

beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
// Drafts a test leaves approved would otherwise fill the next test's batch.
afterEach(async () => {
  if (locationIds.length)
    await db
      .update(s.replyDrafts)
      .set({ status: "rejected" })
      .where(and(eq(s.replyDrafts.status, "approved"), inArray(s.replyDrafts.locationId, locationIds)));
});
afterAll(async () => {
  if (businessIds.length) await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds));
});

describe("postApprovedReplies", () => {
  it("posts an approved draft's final text with the location's token, marks it posted and audits IDs only", async () => {
    const l = await location();
    const d = await draft(l, { finalText: "Edited by the owner: thank you!" });
    const poster = new FakePoster();
    const res = await run(poster);

    expect(poster.for(d.googleReviewId)).toEqual([
      {
        location: { googleLocationId: l.googleLocationId, refreshToken: `rt-${l.locationId}` },
        reviewId: d.googleReviewId,
        comment: "Edited by the owner: thank you!",
      },
    ]);
    expect(await draftRow(d.draftId)).toMatchObject({ status: "posted", postedAt: NOW });
    expect(res.posted).toBeGreaterThanOrEqual(1);

    const audit = await auditOf(d.draftId);
    const posted = audit.filter((a) => a.action === "reply_posted");
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ locationId: l.locationId, actor: "system:reply_post", at: NOW });
    for (const a of audit) expect(a.detail ?? "").not.toMatch(/thank|leak|Sam|rt-/i);
  });

  it("never posts a draft the owner has not approved, or one already posted", async () => {
    const l = await location();
    const others = await Promise.all(
      (["draft", "awaiting_owner", "held", "rejected", "failed", "posted"] as const).map((status) =>
        draft(l, { status }),
      ),
    );
    const poster = new FakePoster();
    await run(poster);
    for (const d of others) expect(poster.for(d.googleReviewId)).toEqual([]);
    expect((await draftRow(others[2].draftId)).status).toBe("held");
  });

  it("posts each draft once across repeated and overlapping runs", async () => {
    const l = await location();
    const d = await draft(l);
    const poster = new FakePoster();
    await Promise.all([run(poster), run(poster), run(poster)]);
    await run(poster);
    expect(poster.for(d.googleReviewId)).toHaveLength(1);
    expect((await auditOf(d.draftId)).filter((a) => a.action === "reply_posted")).toHaveLength(1);
  });

  it("does not overwrite a reply the business already has on Google (D-6 default)", async () => {
    const l = await location();
    const d = await draft(l, { hasReply: true });
    const poster = new FakePoster();
    const res = await run(poster);
    expect(poster.for(d.googleReviewId)).toEqual([]);
    expect(await draftRow(d.draftId)).toMatchObject({ status: "failed", postedAt: null });
    expect(res.failed).toContainEqual({ draftId: d.draftId, code: "already_replied" });
    expect((await auditOf(d.draftId)).find((a) => a.action === "reply_post_failed")?.detail).toBe(
      "code=already_replied",
    );
  });

  it("posts only for live businesses with a connected location, leaving other drafts approved", async () => {
    const offboarded = await draft(await location({ status: "offboarded" }));
    const onboarding = await draft(await location({ status: "onboarding" }));
    const paused = await draft(await location({ status: "paused" }));
    const revoked = await draft(await location({ token: "revoked" }));
    const none = await draft(await location({ token: "none" }));
    const poster = new FakePoster();
    await run(poster);
    for (const d of [offboarded, onboarding, paused, revoked, none]) {
      expect(poster.for(d.googleReviewId)).toEqual([]);
      expect((await draftRow(d.draftId)).status).toBe("approved");
    }
  });

  it("keeps the draft approved and marks the token when Google says access was revoked", async () => {
    const l = await location();
    const d = await draft(l, { googleReviewId: `REVOKED${Date.now()}` });
    const poster = new FakePoster(
      new Map([[d.googleReviewId, { error: new GoogleReviewsError(401, "token_revoked", false) }]]),
    );
    const res = await run(poster);
    expect((await draftRow(d.draftId)).status).toBe("approved");
    const [token] = await db.select().from(s.oauthTokens).where(eq(s.oauthTokens.locationId, l.locationId));
    expect(token.status).toBe("refresh_failed");
    expect(res.waiting).toContainEqual({ draftId: d.draftId, code: "token_revoked" });
    expect((await auditOf(d.draftId)).find((a) => a.action === "reply_post_failed")?.detail).toBe("code=token_revoked");
  });

  it("leaves a draft approved after a transient failure, and the next run posts it", async () => {
    const l = await location();
    const d = await draft(l, { googleReviewId: `FLAKY${Date.now()}` });
    const poster = new FakePoster(
      new Map([[d.googleReviewId, { error: new GoogleReviewsError(503, "http_error", true), times: 1 }]]),
    );
    const first = await run(poster);
    expect((await draftRow(d.draftId)).status).toBe("approved");
    expect(first.waiting).toContainEqual({ draftId: d.draftId, code: "http_error" });
    await run(poster);
    expect(poster.for(d.googleReviewId)).toHaveLength(2);
    expect((await draftRow(d.draftId)).status).toBe("posted");
  });

  it("marks a draft failed when Google refuses it for good", async () => {
    const l = await location();
    const cases = ["rejected", "invalid_reply", "invalid_review"] as const;
    const drafts = await Promise.all(cases.map((c) => draft(l, { googleReviewId: `${c}x${Date.now()}` })));
    const poster = new FakePoster(
      new Map(drafts.map((d, i) => [d.googleReviewId, { error: new GoogleReviewsError(400, cases[i], false) }])),
    );
    const res = await run(poster);
    for (const [i, d] of drafts.entries()) {
      expect(await draftRow(d.draftId)).toMatchObject({ status: "failed", postedAt: null });
      expect(res.failed).toContainEqual({ draftId: d.draftId, code: cases[i] });
    }
  });

  it("leaves drafts approved when the stored token cannot be read", async () => {
    const l = await location({ token: "garbled" });
    const d = await draft(l);
    const poster = new FakePoster();
    const res = await run(poster);
    expect(poster.for(d.googleReviewId)).toEqual([]);
    expect((await draftRow(d.draftId)).status).toBe("approved");
    expect(res.waiting).toContainEqual({ draftId: d.draftId, code: "token_unreadable" });
  });

  it("treats an unexpected error as transient", async () => {
    const l = await location();
    const d = await draft(l, { googleReviewId: `ODD${Date.now()}` });
    const poster = new FakePoster(new Map([[d.googleReviewId, { error: new TypeError("boom") }]]));
    const res = await run(poster);
    expect((await draftRow(d.draftId)).status).toBe("approved");
    expect(res.waiting).toContainEqual({ draftId: d.draftId, code: "error" });
  });

  it("finishes a post that reached Google but was never recorded, instead of calling it the owner's reply", async () => {
    const l = await location();
    const d = await draft(l, { googleReviewId: `LOST${Date.now()}` });
    // Google stored the reply, but the answer never arrived (timeout).
    const poster = new FakePoster(
      new Map([[d.googleReviewId, { error: new GoogleReviewsError(0, "timeout", true), times: 1 }]]),
    );
    await run(poster);
    expect((await draftRow(d.draftId)).status).toBe("approved");
    // The next poll sees our reply on Google.
    await db.update(s.reviews).set({ hasReply: true }).where(eq(s.reviews.id, d.reviewId));
    const res = await run(poster);
    expect(await draftRow(d.draftId)).toMatchObject({ status: "posted", postedAt: NOW });
    expect(res.failed.map((f) => f.draftId)).not.toContain(d.draftId);
    expect(poster.for(d.googleReviewId)).toHaveLength(2); // the same text again: Google keeps one reply
    expect((await auditOf(d.draftId)).filter((a) => a.action === "reply_post_attempt")).toHaveLength(2);
  });

  it("keeps a draft approved when Google answers 404 (lost access looks the same as a deleted review)", async () => {
    const l = await location();
    const d = await draft(l, { googleReviewId: `GONE${Date.now()}` });
    const poster = new FakePoster(
      new Map([[d.googleReviewId, { error: new GoogleReviewsError(404, "not_found", false) }]]),
    );
    const res = await run(poster);
    expect((await draftRow(d.draftId)).status).toBe("approved");
    expect(res.waiting).toContainEqual({ draftId: d.draftId, code: "not_found" });
  });

  it("skips locations whose poll failed in this run", async () => {
    const l = await location();
    const d = await draft(l);
    const poster = new FakePoster();
    const res = await run(poster, { skipLocationIds: new Set([l.locationId]) });
    expect(poster.for(d.googleReviewId)).toEqual([]);
    expect((await draftRow(d.draftId)).status).toBe("approved");
    expect(res.waiting).toContainEqual({ draftId: d.draftId, code: "poll_failed" });
  });

  it("stops starting new posts when the time budget is used up", async () => {
    const l = await location();
    const a = await draft(l);
    const b = await draft(l);
    let t = 0;
    const poster = new FakePoster();
    const res = await run(poster, { budgetMs: 1000, clock: () => (t += 600) });
    const called = [a, b].filter((d) => poster.for(d.googleReviewId).length > 0);
    expect(called).toHaveLength(1);
    expect(res.waiting.filter((w) => w.code === "time_budget").map((w) => w.draftId)).toContain(
      [a, b].find((d) => !called.includes(d))!.draftId,
    );
  });

  it("audits an unreadable token once per location per run", async () => {
    const l = await location({ token: "garbled" });
    await draft(l);
    await draft(l);
    await run(new FakePoster());
    const rows = await db
      .select()
      .from(s.auditLog)
      .where(
        and(
          eq(s.auditLog.locationId, l.locationId),
          eq(s.auditLog.action, "reply_post_failed"),
          eq(s.auditLog.detail, "code=token_unreadable"),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
