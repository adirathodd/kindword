// Runs against the Postgres in DATABASE_URL. Fake data only; the Google API is a fake ReviewSource.
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import {
  GoogleReviewsError,
  type GoogleReview,
  type ReviewSource,
  type ReviewSourceLocation,
} from "../google/businessProfile";
import { encryptRefreshToken } from "../google/tokenCrypto";
import { purgeExpiredReviews } from "./purge";
import { pollReviews } from "./poll";

const SECRET = "test-only-google-token-secret-0123456789";
const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;

class FakeSource implements ReviewSource {
  calls: ReviewSourceLocation[] = [];
  constructor(private readonly byLocation: Map<string, GoogleReview[] | Error>) {}
  async listReviews(l: ReviewSourceLocation) {
    this.calls.push(l);
    const r = this.byLocation.get(l.googleLocationId) ?? [];
    if (r instanceof Error) throw r;
    return r;
  }
}

const businessIds: string[] = [];
let n = 0;
async function connected(
  opts: {
    status?: (typeof s.businessStatus.enumValues)[number];
    token?: "active" | "revoked" | "none" | "garbled";
  } = {},
) {
  const [b] = await db
    .insert(s.businesses)
    .values({ name: "Poll Test HVAC", vertical: "hvac", status: opts.status ?? "live" })
    .returning();
  businessIds.push(b.id);
  const googleLocationId = `accounts/77/locations/${Date.now()}${++n}`;
  const [l] = await db
    .insert(s.locations)
    .values({
      businessId: b.id,
      name: "Main",
      timezone: "America/New_York",
      reviewLink: "https://g.page/r/t",
      googleLocationId,
    })
    .returning();
  const token = opts.token ?? "active";
  if (token !== "none")
    await db.insert(s.oauthTokens).values({
      locationId: l.id,
      encryptedRefreshToken: token === "garbled" ? "v1.garbled" : encryptRefreshToken(`rt-${l.id}`, l.id, SECRET),
      scopes: ["https://www.googleapis.com/auth/business.manage"],
      ...(token === "revoked" ? { revokedAt: NOW, status: "revoked" as const } : {}),
    });
  return { locationId: l.id, googleLocationId };
}

const g = (reviewId: string, extra: Partial<GoogleReview> = {}): GoogleReview => ({
  reviewId,
  rating: 5,
  comment: "Great service.",
  reviewerName: "Sam Example",
  createdAt: new Date("2026-11-20T12:00:00Z"),
  hasReply: false,
  ...extra,
});

const stored = (locationId: string) => db.select().from(s.reviews).where(eq(s.reviews.locationId, locationId));
const audit = (locationId: string, action: string) =>
  db
    .select()
    .from(s.auditLog)
    .where(and(eq(s.auditLog.locationId, locationId), eq(s.auditLog.action, action)));

beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
afterAll(async () => {
  if (businessIds.length) await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds));
});

describe("pollReviews", () => {
  it("stores new unanswered reviews with the decrypted token, and audits IDs only", async () => {
    const t = await connected();
    const source = new FakeSource(
      new Map([[t.googleLocationId, [g("A1"), g("A2", { rating: 1, comment: null, reviewerName: null })]]]),
    );
    const res = await pollReviews({ source, tokenSecret: SECRET, now: NOW });
    expect(res.failed.filter((f) => f.locationId === t.locationId)).toEqual([]);
    expect(source.calls.find((c) => c.googleLocationId === t.googleLocationId)?.refreshToken).toBe(
      `rt-${t.locationId}`,
    );

    const rows = await stored(t.locationId);
    expect(rows.map((r) => r.googleReviewId).sort()).toEqual(["A1", "A2"]);
    expect(rows.find((r) => r.googleReviewId === "A2")).toMatchObject({
      rating: 1,
      text: null,
      reviewerName: null,
      hasReply: false,
      fetchedAt: NOW,
    });
    expect(rows.find((r) => r.googleReviewId === "A1")).toMatchObject({
      text: "Great service.",
      reviewerName: "Sam Example",
      postedAt: new Date("2026-11-20T12:00:00Z"),
    });

    const fetched = await audit(t.locationId, "fetched");
    expect(fetched.map((a) => a.entityId).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(await audit(t.locationId, "reviews_polled")).toHaveLength(1);
    const all = await db.select().from(s.auditLog).where(eq(s.auditLog.locationId, t.locationId));
    for (const a of all) expect(`${a.detail ?? ""}${a.actor}`).not.toMatch(/Great|Sam|rt-/);
  });

  it("refreshes known reviews on every run (keeping them from the purge) and inserts each review once", async () => {
    const t = await connected();
    const reviews = [g("B1")];
    const source = new FakeSource(new Map([[t.googleLocationId, reviews]]));
    const old = new Date(NOW.getTime() - 29.5 * DAY);
    await pollReviews({ source, tokenSecret: SECRET, now: old });
    expect((await stored(t.locationId))[0].fetchedAt).toEqual(old);

    // Edited on Google: new rating and text, and the owner replied there.
    reviews[0] = g("B1", { rating: 3, comment: "Okay service.", hasReply: true });
    await pollReviews({ source, tokenSecret: SECRET, now: NOW });
    const [r] = await stored(t.locationId);
    expect(r).toMatchObject({ rating: 3, text: "Okay service.", hasReply: true, fetchedAt: NOW });
    expect(await audit(t.locationId, "fetched")).toHaveLength(1);

    await purgeExpiredReviews({ now: NOW });
    expect(await stored(t.locationId)).toHaveLength(1); // refreshed, so kept
  });

  it("does not store a new review the business already answered on Google", async () => {
    const t = await connected();
    const source = new FakeSource(new Map([[t.googleLocationId, [g("C1", { hasReply: true }), g("C2")]]]));
    const res = await pollReviews({ source, tokenSecret: SECRET, now: NOW });
    expect((await stored(t.locationId)).map((r) => r.googleReviewId)).toEqual(["C2"]);
    expect(res.newReviews).toBeGreaterThanOrEqual(1);
  });

  it("stores each review once when two runs race, and ignores duplicate IDs in one response", async () => {
    const t = await connected();
    const source = new FakeSource(new Map([[t.googleLocationId, [g("D1"), g("D1"), g("D2")]]]));
    await Promise.all([
      pollReviews({ source, tokenSecret: SECRET, now: NOW }),
      pollReviews({ source, tokenSecret: SECRET, now: NOW }),
    ]);
    expect((await stored(t.locationId)).map((r) => r.googleReviewId).sort()).toEqual(["D1", "D2"]);
    expect(await audit(t.locationId, "fetched")).toHaveLength(2);
  });

  it("never touches a review that belongs to another location", async () => {
    const a = await connected();
    const b = await connected();
    await pollReviews({
      source: new FakeSource(new Map([[a.googleLocationId, [g("E1")]]])),
      tokenSecret: SECRET,
      now: NOW,
    });
    const later = new Date(NOW.getTime() + 1000);
    await pollReviews({
      source: new FakeSource(new Map([[b.googleLocationId, [g("E1", { rating: 1, comment: "Hijack" })]]])),
      tokenSecret: SECRET,
      now: later,
    });
    expect(await stored(b.locationId)).toEqual([]);
    expect((await stored(a.locationId))[0]).toMatchObject({ rating: 5, text: "Great service." });
  });

  it("skips unconnected, revoked and offboarded locations", async () => {
    const none = await connected({ token: "none" });
    const revoked = await connected({ token: "revoked" });
    const off = await connected({ status: "offboarded" });
    const onboarding = await connected({ status: "onboarding" });
    const source = new FakeSource(
      new Map([none, revoked, off, onboarding].map((t) => [t.googleLocationId, [g(`F-${t.locationId}`)]])),
    );
    await pollReviews({ source, tokenSecret: SECRET, now: NOW });
    const polled = new Set(source.calls.map((c) => c.googleLocationId));
    expect(polled.has(none.googleLocationId)).toBe(false);
    expect(polled.has(revoked.googleLocationId)).toBe(false);
    expect(polled.has(off.googleLocationId)).toBe(false);
    expect(polled.has(onboarding.googleLocationId)).toBe(true); // Google is connected during onboarding (Flow 1)
  });

  it("marks a revoked grant refresh_failed and stops polling it; other failures leave the token alone", async () => {
    const revoked = await connected();
    const down = await connected();
    const fine = await connected();
    const source = new FakeSource(
      new Map<string, GoogleReview[] | Error>([
        [revoked.googleLocationId, new GoogleReviewsError(400, "token_revoked", false)],
        [down.googleLocationId, new GoogleReviewsError(503, "http_error", true)],
        [fine.googleLocationId, [g("G1")]],
      ]),
    );
    const res = await pollReviews({ source, tokenSecret: SECRET, now: NOW });
    expect(res.failed).toEqual(
      expect.arrayContaining([
        { locationId: revoked.locationId, code: "token_revoked" },
        { locationId: down.locationId, code: "http_error" },
      ]),
    );
    const status = async (l: string) =>
      (await db.select().from(s.oauthTokens).where(eq(s.oauthTokens.locationId, l)))[0].status;
    expect(await status(revoked.locationId)).toBe("refresh_failed");
    expect(await status(down.locationId)).toBe("active");
    expect(await stored(fine.locationId)).toHaveLength(1); // one location's failure doesn't stop the others
    expect(await audit(revoked.locationId, "review_poll_failed")).toMatchObject([{ detail: "code=token_revoked" }]);

    source.calls = [];
    await pollReviews({ source, tokenSecret: SECRET, now: NOW });
    expect(source.calls.map((c) => c.googleLocationId)).not.toContain(revoked.googleLocationId);
    expect(source.calls.map((c) => c.googleLocationId)).toContain(down.googleLocationId); // retried next run
  });

  it("reports a token it cannot decrypt without calling Google", async () => {
    const t = await connected({ token: "garbled" });
    const source = new FakeSource(new Map());
    const res = await pollReviews({ source, tokenSecret: SECRET, now: NOW });
    expect(res.failed).toContainEqual({ locationId: t.locationId, code: "token_unreadable" });
    expect(source.calls.map((c) => c.googleLocationId)).not.toContain(t.googleLocationId);
  });
});
