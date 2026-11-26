// Runs against the Postgres in DATABASE_URL. Fake data only: example.test emails, made-up reviews.
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import type { EmailMessage, EmailProvider } from "../email/provider";
import { DIGEST_HOUR, localDayAndHour, sendDailyDigests, sendLowRatingAlerts } from "./ownerEmails";

const BASE = "https://app.example.test";
const HOUR = 60 * 60 * 1000;
// 15:00 UTC = 10:00 a.m. in New York (EST, after the November change), past the 8 a.m. digest hour.
const NOW = new Date("2026-11-25T15:00:00Z");

class FakeEmail implements EmailProvider {
  sent: EmailMessage[] = [];
  failNext = 0;
  async send(m: EmailMessage) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("provider down");
    }
    this.sent.push(m);
  }
}

const businessIds: string[] = [];
let n = 0;
async function tenant(
  opts: {
    ownerEmail?: string | null;
    status?: (typeof s.businessStatus.enumValues)[number];
    timezone?: string;
    disabledAccount?: boolean;
  } = {},
) {
  const [b] = await db
    .insert(s.businesses)
    .values({
      name: "Digest Test Plumbing",
      vertical: "plumbing",
      ownerEmail: opts.ownerEmail === undefined ? " Owner@Example.test " : opts.ownerEmail,
      status: opts.status ?? "live",
    })
    .returning();
  businessIds.push(b.id);
  const [l] = await db
    .insert(s.locations)
    .values({
      businessId: b.id,
      name: "Main St",
      timezone: opts.timezone ?? "America/New_York",
      reviewLink: "https://g.page/r/t",
    })
    .returning();
  if (opts.disabledAccount !== undefined)
    await db.insert(s.ownerAccounts).values({
      businessId: b.id,
      name: "Owner",
      email: `owner-${b.id}@example.test`,
      normalizedEmail: `owner-${b.id}@example.test`,
      passwordHash: "x",
      termsVersion: "2026-11-23",
      termsAcceptedAt: NOW,
      disabledAt: opts.disabledAccount ? NOW : null,
    });
  return l.id;
}

async function review(locationId: string, opts: { rating?: number; hasReply?: boolean } = {}) {
  const [r] = await db
    .insert(s.reviews)
    .values({
      locationId,
      googleReviewId: `digest-test-${locationId}-${n++}`,
      rating: opts.rating ?? 5,
      text: "Secret review text from Pat Reviewer.",
      reviewerName: "Pat Reviewer",
      hasReply: opts.hasReply ?? false,
      fetchedAt: NOW,
    })
    .returning();
  return r.id;
}

async function draft(
  locationId: string,
  opts: { status?: (typeof s.draftStatus.enumValues)[number]; createdAt?: Date; rating?: number } = {},
) {
  const reviewId = await review(locationId, { rating: opts.rating });
  const [d] = await db
    .insert(s.replyDrafts)
    .values({
      reviewId,
      locationId,
      draftText: "Secret reply text, thank you Pat.",
      status: opts.status ?? "awaiting_owner",
      model: "test",
      promptVersion: 1,
      createdAt: opts.createdAt ?? new Date(NOW.getTime() - 2 * HOUR),
    })
    .returning();
  return { draftId: d.id, reviewId };
}

const audit = (locationId: string, action: string) =>
  db
    .select()
    .from(s.auditLog)
    .where(and(eq(s.auditLog.locationId, locationId), eq(s.auditLog.action, action)));

const to = (email: FakeEmail, locationId: string) => email.sent.filter((m) => m.idempotencyKey?.includes(locationId));

let email: FakeEmail;
beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
beforeEach(() => {
  email = new FakeEmail();
});
afterAll(async () => {
  if (businessIds.length) await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds));
});

describe("localDayAndHour", () => {
  it("uses the location's zone, including daylight saving", () => {
    expect(localDayAndHour(new Date("2026-11-25T04:30:00Z"), "America/New_York")).toEqual({
      day: "2026-11-24",
      hour: 23,
    });
    expect(localDayAndHour(new Date("2026-07-01T12:00:00Z"), "America/New_York")).toEqual({
      day: "2026-07-01",
      hour: 8,
    });
  });
});

describe("sendDailyDigests", () => {
  it("sends one digest a day listing waiting drafts, marks the overdue ones, and carries no review content", async () => {
    const loc = await tenant();
    await draft(loc, { rating: 5, createdAt: new Date(NOW.getTime() - 3 * HOUR) });
    await draft(loc, { rating: 1, status: "held", createdAt: new Date(NOW.getTime() - 50 * HOUR) });
    await draft(loc, { status: "approved" }); // not waiting for the owner
    await draft(loc, { status: "rejected" });

    await sendDailyDigests({ email, baseUrl: BASE, now: NOW });
    const mine = to(email, loc);
    expect(mine).toHaveLength(1);
    const m = mine[0];
    expect(m.to).toBe("owner@example.test");
    expect(m.idempotencyKey).toBe(`owner-digest/${loc}/2026-11-25`);
    expect(m.subject).toBe("2 replies waiting for you: Digest Test Plumbing (1 overdue)");
    expect(m.text).toContain("2 replies are waiting for your approval at Digest Test Plumbing (Main St), 1 overdue");
    expect(m.text).toContain("- 5-star review, waiting 3 hours");
    expect(m.text).toContain("- 1-star review, waiting 2 days, needs extra care, overdue");
    expect(m.text).toContain(`Open your reply inbox: ${BASE}/inbox`);
    expect(m.text).toContain("Nothing is posted until you approve it.");
    expect(m.html).toContain(`<a href="${BASE}/inbox">`);
    for (const body of [m.text, m.html, m.subject]) {
      expect(body).not.toMatch(/Secret|Pat/);
    }
    expect(await audit(loc, "owner_digest_sent")).toMatchObject([
      { entity: "location", entityId: loc, detail: "day=2026-11-25", actor: "system:owner_email" },
    ]);

    // Later runs the same local day send nothing; the next day sends again while drafts still wait.
    await sendDailyDigests({ email, baseUrl: BASE, now: new Date(NOW.getTime() + 5 * HOUR) });
    expect(to(email, loc)).toHaveLength(1);
    await sendDailyDigests({ email, baseUrl: BASE, now: new Date(NOW.getTime() + 24 * HOUR) });
    expect(to(email, loc).map((x) => x.idempotencyKey)).toEqual([
      `owner-digest/${loc}/2026-11-25`,
      `owner-digest/${loc}/2026-11-26`,
    ]);
  });

  it("sends nothing on days without waiting drafts", async () => {
    const loc = await tenant();
    await draft(loc, { status: "posted" });
    await draft(loc, { status: "approved" });
    await sendDailyDigests({ email, baseUrl: BASE, now: NOW });
    expect(to(email, loc)).toHaveLength(0);
    expect(await audit(loc, "owner_digest_sent")).toHaveLength(0);
  });

  it("waits for the digest hour in the location's own time zone", async () => {
    const ny = await tenant();
    const la = await tenant({ timezone: "America/Los_Angeles" }); // 7 a.m. there
    await draft(ny);
    await draft(la);
    await sendDailyDigests({ email, baseUrl: BASE, now: NOW });
    expect(to(email, ny)).toHaveLength(1);
    expect(to(email, la)).toHaveLength(0);
    await sendDailyDigests({ email, baseUrl: BASE, now: new Date(NOW.getTime() + HOUR) });
    expect(to(email, la)).toHaveLength(1);
    expect(DIGEST_HOUR).toBe(8);
  });

  it("skips offboarded businesses, disabled accounts and businesses with no owner email", async () => {
    const off = await tenant({ status: "offboarded" });
    const disabled = await tenant({ disabledAccount: true });
    const noEmail = await tenant({ ownerEmail: null });
    const enabled = await tenant({ disabledAccount: false, status: "onboarding" });
    for (const l of [off, disabled, noEmail, enabled]) await draft(l);
    await sendDailyDigests({ email, baseUrl: BASE, now: NOW });
    expect(to(email, off)).toHaveLength(0);
    expect(to(email, disabled)).toHaveLength(0);
    expect(to(email, noEmail)).toHaveLength(0);
    expect(to(email, enabled)).toHaveLength(1);
  });

  it("retries a failed send on the next run under the same key, without stopping other locations", async () => {
    const a = await tenant();
    const b = await tenant();
    await draft(a);
    await draft(b);
    email.failNext = 1;
    const first = await sendDailyDigests({ email, baseUrl: BASE, now: NOW });
    expect(first.failed).toBeGreaterThanOrEqual(1);
    const failedLoc = to(email, a).length ? b : a;
    const okLoc = failedLoc === a ? b : a;
    expect(to(email, okLoc)).toHaveLength(1);
    expect(await audit(failedLoc, "owner_digest_sent")).toHaveLength(0);
    // Recorded for operator alerts: the location, the local day and an error code only.
    const failures = await audit(failedLoc, "owner_email_failed");
    expect(failures.map((f) => [f.entity, f.entityId, f.detail])).toEqual([
      ["location", failedLoc, "kind=digest;period=2026-11-25;error=Error"],
    ]);
    expect(await audit(okLoc, "owner_email_failed")).toHaveLength(0);

    await sendDailyDigests({ email, baseUrl: BASE, now: new Date(NOW.getTime() + HOUR) });
    expect(to(email, failedLoc)).toHaveLength(1);
    expect(to(email, failedLoc)[0].idempotencyKey).toBe(`owner-digest/${failedLoc}/2026-11-25`);
    expect(to(email, okLoc)).toHaveLength(1);
  });

  it("sends once when two runs race", async () => {
    const loc = await tenant();
    await draft(loc);
    await Promise.all([
      sendDailyDigests({ email, baseUrl: BASE, now: NOW }),
      sendDailyDigests({ email, baseUrl: BASE, now: NOW }),
    ]);
    expect(to(email, loc)).toHaveLength(1);
    expect(await audit(loc, "owner_digest_sent")).toHaveLength(1);
  });

  it("records a bad time zone as a failure for the UTC day, with the provider's codes kept short", async () => {
    const loc = await tenant({ timezone: "Not/AZone" });
    await draft(loc);
    expect((await sendDailyDigests({ email, baseUrl: BASE, now: NOW })).failed).toBeGreaterThanOrEqual(1);
    expect((await audit(loc, "owner_email_failed")).map((f) => f.detail)).toEqual([
      "kind=digest;period=2026-11-25;error=bad_time_zone",
    ]);
  });

  it("escapes business and location names in the HTML", async () => {
    const loc = await tenant();
    await db.update(s.locations).set({ name: "<b>Main</b>" }).where(eq(s.locations.id, loc));
    await draft(loc);
    await sendDailyDigests({ email, baseUrl: BASE, now: NOW });
    const m = to(email, loc)[0];
    expect(m.html).toContain("&lt;b&gt;Main&lt;/b&gt;");
    expect(m.html).not.toContain("<b>Main</b>");
  });
});

describe("sendLowRatingAlerts", () => {
  it("emails once about a new review of 2 stars or lower, with no review content", async () => {
    const loc = await tenant();
    const low = await review(loc, { rating: 2 });
    await review(loc, { rating: 3 });
    await review(loc, { rating: 1, hasReply: true }); // already answered on Google

    await sendLowRatingAlerts({ email, baseUrl: BASE, now: NOW });
    const mine = to(email, loc);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      to: "owner@example.test",
      subject: "New 2-star review: Digest Test Plumbing",
      idempotencyKey: `low-rating/${loc}/${low}`,
    });
    expect(mine[0].text).toContain("A new 2-star review for Digest Test Plumbing (Main St) needs a reply.");
    expect(mine[0].text).toContain(`${BASE}/inbox`);
    for (const body of [mine[0].text, mine[0].html]) expect(body).not.toMatch(/Secret|Pat/);
    expect(await audit(loc, "low_rating_email_sent")).toMatchObject([{ entity: "review", entityId: low }]);

    await sendLowRatingAlerts({ email, baseUrl: BASE, now: NOW });
    expect(to(email, loc)).toHaveLength(1);
  });

  it("batches the low-rated reviews found in one run into one email per location", async () => {
    const loc = await tenant();
    await review(loc, { rating: 1 });
    await review(loc, { rating: 2 });
    await sendLowRatingAlerts({ email, baseUrl: BASE, now: NOW });
    const mine = to(email, loc);
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toBe("2 new low-rated reviews: Digest Test Plumbing");
    expect(mine[0].text).toContain("- 1-star review");
    expect(mine[0].text).toContain("- 2-star review");
    expect(await audit(loc, "low_rating_email_sent")).toHaveLength(2);

    // A later low review gets its own email; the earlier ones are not repeated.
    await review(loc, { rating: 1 });
    await sendLowRatingAlerts({ email, baseUrl: BASE, now: NOW });
    expect(to(email, loc)).toHaveLength(2);
    expect(to(email, loc)[1].subject).toBe("New 1-star review: Digest Test Plumbing");
  });

  it("skips reviews the owner already handled, and owners who cannot be emailed", async () => {
    const loc = await tenant();
    await draft(loc, { rating: 1, status: "rejected" });
    await draft(loc, { rating: 2, status: "approved" });
    const off = await tenant({ status: "offboarded" });
    await review(off, { rating: 1 });
    const disabled = await tenant({ disabledAccount: true });
    await review(disabled, { rating: 1 });
    await sendLowRatingAlerts({ email, baseUrl: BASE, now: NOW });
    expect(to(email, loc)).toHaveLength(0);
    expect(to(email, off)).toHaveLength(0);
    expect(to(email, disabled)).toHaveLength(0);
  });

  it("retries after a provider failure and sends once when runs race", async () => {
    await sendLowRatingAlerts({ email, baseUrl: BASE, now: NOW }); // flush other tests' leftovers
    const loc = await tenant();
    await review(loc, { rating: 1 });
    email.failNext = 1;
    expect(await sendLowRatingAlerts({ email, baseUrl: BASE, now: NOW })).toEqual({ sent: 0, failed: 1 });
    expect(await audit(loc, "low_rating_email_sent")).toHaveLength(0);
    expect((await audit(loc, "owner_email_failed")).map((f) => f.detail)).toEqual([
      "kind=low_rating;period=2026-11-25;error=Error",
    ]);
    await Promise.all([
      sendLowRatingAlerts({ email, baseUrl: BASE, now: NOW }),
      sendLowRatingAlerts({ email, baseUrl: BASE, now: NOW }),
    ]);
    expect(to(email, loc)).toHaveLength(1);
    expect(await audit(loc, "low_rating_email_sent")).toHaveLength(1);
  });
});
