// Runs against the Postgres in DATABASE_URL. Fake data only.
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import { purgeExpiredReviews } from "./purge";

const DAY = 24 * 60 * 60 * 1000;
// Real time, so rows other test files leave behind (fetched "now") are never expired and never counted here.
const NOW = new Date();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

const businessIds: string[] = [];
let n = 0;
async function makeLocation() {
  const [b] = await db.insert(s.businesses).values({ name: "Purge Test Plumbing", vertical: "plumbing" }).returning();
  businessIds.push(b.id);
  const [l] = await db
    .insert(s.locations)
    .values({ businessId: b.id, name: "Main", timezone: "America/New_York", reviewLink: "https://g.page/r/test" })
    .returning();
  const [o] = await db
    .insert(s.ownerSessions)
    .values({ locationId: l.id, ownerEmail: "o@example.test", loginTokenHash: `h-${l.id}`, tokenExpiresAt: NOW })
    .returning();
  return { locationId: l.id, sessionId: o.id };
}

async function review(locationId: string, fetchedAt: Date) {
  const [r] = await db
    .insert(s.reviews)
    .values({
      locationId,
      googleReviewId: `purge-test-${++n}-${locationId}`,
      rating: 4,
      text: "Fixed our leak fast.",
      reviewerName: "Pat Example",
      fetchedAt,
    })
    .returning();
  return r.id;
}

const draft = (reviewId: string, locationId: string) => ({
  reviewId,
  locationId,
  draftText: "Thanks, Pat!",
  model: "test",
  promptVersion: 1,
});

const reviewIds = async (locationId: string) =>
  (await db.select({ id: s.reviews.id }).from(s.reviews).where(eq(s.reviews.locationId, locationId))).map((r) => r.id);
const draftsOf = (locationId: string) =>
  db.select().from(s.replyDrafts).where(eq(s.replyDrafts.locationId, locationId));
const auditOf = (locationId: string) => db.select().from(s.auditLog).where(eq(s.auditLog.locationId, locationId));

let t: Awaited<ReturnType<typeof makeLocation>>;
beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
beforeEach(async () => {
  t = await makeLocation();
});
afterAll(async () => {
  if (businessIds.length) await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds));
  await db.$client.end();
});

describe("purgeExpiredReviews", () => {
  it("deletes reviews past the cutoff with their drafts and keeps recent ones", async () => {
    const old = await review(t.locationId, daysAgo(31));
    const fresh = await review(t.locationId, daysAgo(2));
    await db.insert(s.replyDrafts).values([draft(old, t.locationId), draft(old, t.locationId)]);
    await db.insert(s.replyDrafts).values(draft(fresh, t.locationId));

    const r = await purgeExpiredReviews({ now: NOW });
    expect(r).toMatchObject({ reviews: 1, drafts: 2 });
    expect(await reviewIds(t.locationId)).toEqual([fresh]);
    expect((await draftsOf(t.locationId)).map((d) => d.reviewId)).toEqual([fresh]);
  });

  it("purges a day early by default so a daily run never lets content reach 30 days", async () => {
    const at29 = await review(t.locationId, new Date(daysAgo(29).getTime() - 1000));
    const under29 = await review(t.locationId, new Date(daysAgo(29).getTime() + 1000));
    const r = await purgeExpiredReviews({ now: NOW });
    expect(r.cutoff).toEqual(daysAgo(29));
    expect(await reviewIds(t.locationId)).toEqual([under29]);
    expect(at29).toBeTruthy();
  });

  it("honors a custom margin, including zero (exactly 30 days)", async () => {
    await review(t.locationId, daysAgo(30));
    const kept = await review(t.locationId, daysAgo(29.5));
    expect((await purgeExpiredReviews({ now: NOW, marginMs: 0 })).reviews).toBe(1);
    expect(await reviewIds(t.locationId)).toEqual([kept]);
  });

  it("rejects a margin outside 0 to 30 days", async () => {
    await expect(purgeExpiredReviews({ now: NOW, marginMs: -1 })).rejects.toThrow(/marginMs/);
    await expect(purgeExpiredReviews({ now: NOW, marginMs: 30 * DAY })).rejects.toThrow(/marginMs/);
    await expect(purgeExpiredReviews({ now: NOW, marginMs: NaN })).rejects.toThrow(/marginMs/);
  });

  it("purges approved and posted drafts too, while the audit log keeps the approval record", async () => {
    const old = await review(t.locationId, daysAgo(40));
    const [d] = await db
      .insert(s.replyDrafts)
      .values({
        ...draft(old, t.locationId),
        status: "posted",
        finalText: "Thanks, Pat!",
        approvedSessionId: t.sessionId,
        approvedAt: daysAgo(39),
        postedAt: daysAgo(39),
      })
      .returning();
    await db.insert(s.auditLog).values({
      locationId: t.locationId,
      entity: "reply_draft",
      entityId: d.id,
      action: "approved",
      actor: "owner_session",
      detail: "edited=no;minutes=12",
    });

    await purgeExpiredReviews({ now: NOW });
    expect(await draftsOf(t.locationId)).toEqual([]);
    const audit = await auditOf(t.locationId);
    expect(audit.find((a) => a.action === "approved")).toBeTruthy();
  });

  it("audits each purged review and draft with IDs and counts only", async () => {
    const old = await review(t.locationId, daysAgo(35));
    const [d] = await db.insert(s.replyDrafts).values(draft(old, t.locationId)).returning();
    await purgeExpiredReviews({ now: NOW });

    const audit = (await auditOf(t.locationId)).filter((a) => a.action === "purged");
    expect(audit.map((a) => [a.entity, a.entityId, a.actor, a.detail]).sort()).toEqual([
      ["reply_draft", d.id, "system:purge", "reason=retention_30d"],
      ["review", old, "system:purge", "reason=retention_30d;drafts=1"],
    ]);
    const text = JSON.stringify(audit);
    expect(text).not.toContain("Fixed our leak");
    expect(text).not.toContain("Pat Example");
    expect(text).not.toContain("Thanks, Pat");
  });

  it("purges across locations and businesses", async () => {
    const other = await makeLocation();
    await review(t.locationId, daysAgo(31));
    await review(other.locationId, daysAgo(31));
    const keep = await review(other.locationId, daysAgo(1));
    expect((await purgeExpiredReviews({ now: NOW })).reviews).toBe(2);
    expect(await reviewIds(t.locationId)).toEqual([]);
    expect(await reviewIds(other.locationId)).toEqual([keep]);
  });

  it("is idempotent: a second run purges nothing and writes no audit rows", async () => {
    await review(t.locationId, daysAgo(31));
    await purgeExpiredReviews({ now: NOW });
    const before = (await auditOf(t.locationId)).length;
    expect(await purgeExpiredReviews({ now: NOW })).toMatchObject({ reviews: 0, drafts: 0 });
    expect((await auditOf(t.locationId)).length).toBe(before);
  });

  it("keeps a review whose fetched_at was refreshed by the poller", async () => {
    const id = await review(t.locationId, daysAgo(31));
    await db
      .update(s.reviews)
      .set({ fetchedAt: daysAgo(0) })
      .where(eq(s.reviews.id, id));
    expect((await purgeExpiredReviews({ now: NOW })).reviews).toBe(0);
    expect(await reviewIds(t.locationId)).toEqual([id]);
  });

  it("keeps a review refreshed concurrently while the purge waits on its row lock", async () => {
    const id = await review(t.locationId, daysAgo(31));
    const refresher = await db.$client.connect();
    try {
      await refresher.query("begin");
      await refresher.query("update reviews set fetched_at = $1 where id = $2", [NOW, id]);
      const purge = purgeExpiredReviews({ now: NOW });
      await new Promise((r) => setTimeout(r, 200)); // let the purge block on the row lock
      await refresher.query("commit");
      expect((await purge).reviews).toBe(0);
    } finally {
      refresher.release();
    }
    expect(await reviewIds(t.locationId)).toEqual([id]);
  });

  it("works through more rows than one batch", async () => {
    const rows = Array.from({ length: 501 }, () => ({
      locationId: t.locationId,
      googleReviewId: `purge-batch-${++n}`,
      rating: 5,
      fetchedAt: daysAgo(45),
    }));
    await db.insert(s.reviews).values(rows);
    expect((await purgeExpiredReviews({ now: NOW })).reviews).toBe(501);
    expect(await reviewIds(t.locationId)).toEqual([]);
  });
});
