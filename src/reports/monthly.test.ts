// Runs against the Postgres in DATABASE_URL. Fake data only: example.test emails, made-up reviews, 555-01xx numbers.
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import type { EmailMessage, EmailProvider } from "../email/provider";
import {
  GoogleReviewsError,
  type GoogleReview,
  type ReviewSource,
  type ReviewSourceLocation,
} from "../google/businessProfile";
import { encryptRefreshToken } from "../google/tokenCrypto";
import { googleFigures, median, reportPeriod, sendMonthlyReports, startOfLocalMonth } from "./monthly";

const BASE = "https://app.example.test";
const SECRET = "monthly-test-token-secret-0123456789";
const HOUR = 3_600_000;
// 1 Dec 2026, 14:00 UTC = 9:00 a.m. in New York (EST): past the 8 a.m. send hour on the 1st. Reports cover November.
const NOW = new Date("2026-12-01T14:00:00Z");
const NOV = (iso: string) => new Date(`2026-11-${iso}`);

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

class FakeSource implements ReviewSource {
  calls: ReviewSourceLocation[] = [];
  reviews = new Map<string, GoogleReview[]>();
  fail: GoogleReviewsError | null = null;
  async listReviews(loc: ReviewSourceLocation) {
    this.calls.push(loc);
    if (this.fail) throw this.fail;
    return this.reviews.get(loc.googleLocationId) ?? [];
  }
}

const g = (id: string, rating: number, createdAt: Date | null, repliedAt: Date | null = null): GoogleReview => ({
  reviewId: id,
  rating,
  comment: "Secret review text from Pat Reviewer.",
  reviewerName: "Pat Reviewer",
  createdAt,
  hasReply: repliedAt !== null,
  repliedAt,
});

const businessIds: string[] = [];
const platformAddresses: string[] = []; // platform-wide suppression rows have no location to cascade from
let n = 0;
async function tenant(
  opts: {
    ownerEmail?: string | null;
    status?: (typeof s.businessStatus.enumValues)[number];
    timezone?: string;
    connected?: boolean;
    disabledAccount?: boolean;
  } = {},
) {
  const [b] = await db
    .insert(s.businesses)
    .values({
      name: "Report Test Plumbing",
      vertical: "plumbing",
      ownerEmail: opts.ownerEmail === undefined ? "owner@example.test" : opts.ownerEmail,
      status: opts.status ?? "live",
    })
    .returning();
  businessIds.push(b.id);
  const googleLocationId = `accounts/1/locations/${Date.now()}${n++}`;
  const [l] = await db
    .insert(s.locations)
    .values({
      businessId: b.id,
      name: "Main St",
      timezone: opts.timezone ?? "America/New_York",
      reviewLink: "https://g.page/r/t",
      googleLocationId: opts.connected ? googleLocationId : null,
    })
    .returning();
  if (opts.connected)
    await db.insert(s.oauthTokens).values({
      locationId: l.id,
      encryptedRefreshToken: encryptRefreshToken("rt-test", l.id, SECRET),
      scopes: ["https://www.googleapis.com/auth/business.manage"],
    });
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
  return { businessId: b.id, locationId: l.id, googleLocationId };
}

type T = Awaited<ReturnType<typeof tenant>>;

async function request(
  t: T,
  opts: { attempt: 1 | 2; sentAt: Date | null; status?: "sent" | "failed"; clickedAt?: Date },
) {
  const [c] = await db
    .insert(s.customers)
    .values({
      locationId: t.locationId,
      businessId: t.businessId,
      email: `c${n}@example.test`,
      normalizedEmail: `c${n}@example.test`,
    })
    .returning();
  const [v] = await db
    .insert(s.visits)
    .values({
      customerId: c.id,
      locationId: t.locationId,
      visitAt: opts.sentAt ?? NOV("10T12:00:00Z"),
      source: "csv",
      externalVisitId: `v${n++}`,
    })
    .returning();
  await db.insert(s.reviewRequests).values({
    visitId: v.id,
    scheduledFor: opts.sentAt ?? NOV("10T12:00:00Z"),
    sentAt: opts.sentAt,
    channel: "email",
    status: opts.status ?? "sent",
    attempt: opts.attempt,
    clickedAt: opts.clickedAt ?? null,
  });
}

async function approval(t: T, at: Date, minutes: number) {
  await db.insert(s.auditLog).values({
    locationId: t.locationId,
    entity: "reply_draft",
    entityId: t.locationId,
    action: "approved",
    actor: "owner_session:test",
    detail: `edited=no;minutes=${minutes};flagged=no`,
    at,
  });
}

// A post as src/reviews/post.ts records it: the draft marked posted and one reply_posted audit row. purged: the draft
// and review are gone (FR-22), so only the audit row is left.
async function postedDraft(t: T, postedAt: Date, opts: { purged?: boolean } = {}) {
  let draftId: string = randomUUID();
  if (!opts.purged) {
    const [r] = await db
      .insert(s.reviews)
      .values({
        locationId: t.locationId,
        googleReviewId: `report-test-${n++}`,
        rating: 5,
        text: "Secret review text.",
      })
      .returning();
    const [o] = await db
      .insert(s.ownerSessions)
      .values({
        locationId: t.locationId,
        ownerEmail: "o@example.test",
        loginTokenHash: `h-${n++}`,
        tokenExpiresAt: NOW,
      })
      .returning();
    const [d] = await db
      .insert(s.replyDrafts)
      .values({
        reviewId: r.id,
        locationId: t.locationId,
        draftText: "Secret reply text.",
        finalText: "Secret reply text.",
        status: "posted",
        model: "test",
        promptVersion: 1,
        approvedSessionId: o.id,
        approvedAt: postedAt,
        postedAt,
      })
      .returning();
    draftId = d.id;
  }
  await db.insert(s.auditLog).values({
    locationId: t.locationId,
    entity: "reply_draft",
    entityId: draftId,
    action: "reply_posted",
    actor: "system:reply_post",
    at: postedAt,
  });
}

const sentAudit = (locationId: string) =>
  db
    .select()
    .from(s.auditLog)
    .where(and(eq(s.auditLog.locationId, locationId), eq(s.auditLog.action, "monthly_report_sent")));
const to = (email: FakeEmail, locationId: string) => email.sent.filter((m) => m.idempotencyKey?.includes(locationId));

let email: FakeEmail;
let source: FakeSource;
const run = (now = NOW) => sendMonthlyReports({ email, source, tokenSecret: SECRET, baseUrl: BASE, now });

beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
beforeEach(() => {
  email = new FakeEmail();
  source = new FakeSource();
});
afterAll(async () => {
  if (businessIds.length) await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds));
  if (platformAddresses.length)
    await db.delete(s.suppressionList).where(inArray(s.suppressionList.address, platformAddresses));
});

describe("reportPeriod", () => {
  it("covers the previous calendar month in the location's time zone", () => {
    const p = reportPeriod(NOW, "America/New_York");
    expect(p).toMatchObject({ key: "2026-11", label: "November 2026", due: true, localDay: 1 });
    expect(p.start).toEqual(new Date("2026-11-01T04:00:00Z")); // EDT until Nov 1, 2 a.m.
    expect(p.end).toEqual(new Date("2026-12-01T05:00:00Z")); // EST
    const la = reportPeriod(NOW, "America/Los_Angeles"); // 6 a.m. in Los Angeles: not due yet
    expect(la).toMatchObject({ key: "2026-11", due: false });
    expect(la.start).toEqual(new Date("2026-11-01T07:00:00Z"));
  });

  it("rolls back over the new year and catches up after the 1st", () => {
    const p = reportPeriod(new Date("2027-01-03T03:00:00Z"), "America/New_York"); // Jan 2, 10 p.m.
    expect(p).toMatchObject({ key: "2026-12", label: "December 2026", due: true, localDay: 2 });
    expect(p.start).toEqual(new Date("2026-12-01T05:00:00Z"));
    expect(p.end).toEqual(new Date("2027-01-01T05:00:00Z"));
    expect(startOfLocalMonth(2026, 4, "Europe/London")).toEqual(new Date("2026-03-31T23:00:00Z"));
    expect(() => reportPeriod(NOW, "Not/AZone")).toThrow();
  });
});

describe("figures", () => {
  it("median handles odd, even and empty lists", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("counts only the month's reviews and measures reply time from Google's timestamps", () => {
    const start = new Date("2026-11-01T04:00:00Z");
    const end = new Date("2026-12-01T05:00:00Z");
    const f = googleFigures(
      [
        g("a", 5, NOV("03T12:00:00Z"), NOV("03T14:00:00Z")), // 2 h
        g("b", 4, NOV("10T12:00:00Z"), NOV("11T12:00:00Z")), // 24 h
        g("c", 3, NOV("20T12:00:00Z")), // no reply
        g("d", 1, new Date("2026-11-01T03:59:00Z"), NOV("02T00:00:00Z")), // October, local time
        g("e", 1, new Date("2026-12-01T05:00:00Z")), // December
        g("f", 2, null),
      ],
      start,
      end,
    );
    expect(f).toEqual({ newReviews: 3, averageRating: 4, medianHoursToReply: 13 });
    expect(googleFigures([], start, end)).toEqual({ newReviews: 0, averageRating: null, medianHoursToReply: null });
  });
});

describe("sendMonthlyReports", () => {
  it("sends live Google figures and our own figures once, storing no figures", async () => {
    const t = await tenant({ connected: true });
    const other = await tenant(); // another business: its rows must not be counted
    source.reviews.set(t.googleLocationId, [
      g("a", 5, NOV("03T12:00:00Z"), NOV("03T14:00:00Z")),
      g("b", 4, NOV("10T12:00:00Z"), NOV("11T12:00:00Z")),
      g("c", 2, NOV("20T12:00:00Z")),
      g("old", 1, new Date("2026-10-15T12:00:00Z")),
    ]);
    await request(t, { attempt: 1, sentAt: NOV("05T15:00:00Z"), clickedAt: NOV("05T16:00:00Z") });
    await request(t, { attempt: 1, sentAt: NOV("06T15:00:00Z") });
    await request(t, { attempt: 1, sentAt: null, status: "failed" }); // not sent: not counted
    await request(t, { attempt: 1, sentAt: new Date("2026-10-31T15:00:00Z") }); // October
    await request(t, { attempt: 2, sentAt: NOV("09T15:00:00Z") });
    await request(other, { attempt: 1, sentAt: NOV("05T15:00:00Z"), clickedAt: NOV("05T16:00:00Z") });
    const optedOut = `x-${t.locationId}@example.test`;
    platformAddresses.push(optedOut);
    const at = NOV("07T00:00:00Z");
    await db.insert(s.suppressionList).values([
      { locationId: t.locationId, channel: "email", address: optedOut, source: "test", createdAt: at },
      { locationId: null, channel: "email", address: optedOut, source: "test", createdAt: at }, // platform-wide
      { locationId: other.locationId, channel: "email", address: optedOut, source: "test", createdAt: at },
    ]);
    await approval(t, NOV("04T12:00:00Z"), 30);
    await approval(t, NOV("12T12:00:00Z"), 90);
    await approval(t, NOV("13T12:00:00Z"), 150);
    await approval(t, new Date("2026-10-20T12:00:00Z"), 5); // October
    await approval(other, NOV("12T12:00:00Z"), 1);
    await postedDraft(t, NOV("14T12:00:00Z"));
    await postedDraft(t, NOV("02T12:00:00Z"), { purged: true }); // still counted after its draft is purged (O-53-1)
    await postedDraft(t, new Date("2026-10-28T12:00:00Z"), { purged: true }); // October
    await postedDraft(other, NOV("14T12:00:00Z"));

    await run();
    const [m] = to(email, t.locationId);
    expect(to(email, t.locationId)).toHaveLength(1);
    expect(m).toMatchObject({
      to: "owner@example.test",
      subject: "November 2026 review report: Report Test Plumbing",
      idempotencyKey: `monthly-report/${t.locationId}/2026-11`,
    });
    expect(source.calls).toContainEqual({ googleLocationId: t.googleLocationId, refreshToken: "rt-test" });
    for (const line of [
      "New reviews on Google: 3",
      "Average rating of those reviews: 3.7 of 5",
      "Typical time to reply (median): 13 hours",
      "Review requests sent: 2",
      "Reminders sent: 1",
      "Review link clicks: 1",
      "Customers who opted out: 1",
      "Replies you approved: 3",
      "Typical time to approve (median): 2 hours",
      "Replies posted to Google: 2",
      `Open your reply inbox: ${BASE}/inbox?location=${t.locationId}`,
    ])
      expect(m.text).toContain(line);
    expect(m.html).toContain("Average rating of those reviews: 3.7 of 5");
    for (const body of [m.text, m.html, m.subject]) expect(body).not.toMatch(/Secret|Pat|rt-test/);

    // Only the month is recorded: no rating, count or anything else derived from reviews.
    const rows = await sentAudit(t.locationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity: "location", entityId: t.locationId, detail: "month=2026-11" });

    // A second run this month sends nothing and does not read Google again.
    email = new FakeEmail();
    const callsBefore = source.calls.length;
    await run(new Date(NOW.getTime() + 5 * HOUR));
    await run(new Date("2026-12-15T14:00:00Z"));
    expect(to(email, t.locationId)).toHaveLength(0);
    expect(source.calls.filter((c) => c.googleLocationId === t.googleLocationId)).toHaveLength(
      source.calls.slice(0, callsBefore).filter((c) => c.googleLocationId === t.googleLocationId).length,
    );
    expect(await sentAudit(t.locationId)).toHaveLength(1);
  });

  it("waits for the send hour on the 1st and catches up later in the month", async () => {
    const t = await tenant({ timezone: "America/Los_Angeles" });
    await request(t, { attempt: 1, sentAt: NOV("05T15:00:00Z") });
    await run(); // 6 a.m. in Los Angeles
    expect(to(email, t.locationId)).toHaveLength(0);
    await run(new Date("2026-12-03T02:00:00Z")); // Dec 2, 6 p.m. local: the 1st was missed
    expect(to(email, t.locationId)).toHaveLength(1);
    expect(to(email, t.locationId)[0].text).toContain("Review requests sent: 1");
  });

  it("without a Google connection sends our own figures only, and skips a month with nothing to report", async () => {
    const t = await tenant();
    const quiet = await tenant();
    await request(t, { attempt: 1, sentAt: NOV("05T15:00:00Z") });
    await run();
    const [m] = to(email, t.locationId);
    expect(m.text).toContain("Google review figures need your Google Business Profile connection");
    expect(m.text).not.toContain("New reviews on Google");
    expect(m.text).toContain("Review requests sent: 1");
    expect(to(email, quiet.locationId)).toHaveLength(0);
    expect(await sentAudit(quiet.locationId)).toHaveLength(0);
  });

  it("waits out a passing Google outage on the 1st and 2nd, then sends our own figures with a note", async () => {
    const t = await tenant({ connected: true });
    source.fail = new GoogleReviewsError(503, "http_error", true);
    const r1 = await run();
    expect(to(email, t.locationId)).toHaveLength(0);
    expect(r1.waiting).toBeGreaterThanOrEqual(1);
    expect(await sentAudit(t.locationId)).toHaveLength(0);

    await run(new Date("2026-12-03T14:00:00Z")); // the 3rd
    const [m] = to(email, t.locationId);
    expect(m.text).toContain("We could not read your Google reviews this time");
    expect(m.text).toContain("Review requests sent: 0");
  });

  it("sends our own figures at once when Google access is revoked", async () => {
    const t = await tenant({ connected: true });
    source.fail = new GoogleReviewsError(401, "token_revoked", false);
    await run();
    expect(to(email, t.locationId)[0].text).toContain("We could not read your Google reviews this time");
  });

  it("retries a failed email on the next run under the same key", async () => {
    const t = await tenant();
    await request(t, { attempt: 1, sentAt: NOV("05T15:00:00Z") });
    email.failNext = 1000; // every send fails this run
    const r = await run();
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(await sentAudit(t.locationId)).toHaveLength(0);
    email.failNext = 0;
    await run(new Date(NOW.getTime() + HOUR));
    expect(to(email, t.locationId)).toHaveLength(1);
    expect(await sentAudit(t.locationId)).toHaveLength(1);
  });

  it("two runs at once send one report", async () => {
    const t = await tenant();
    await request(t, { attempt: 1, sentAt: NOV("05T15:00:00Z") });
    await Promise.all([run(), run()]);
    expect(to(email, t.locationId)).toHaveLength(1);
    expect(await sentAudit(t.locationId)).toHaveLength(1);
  });

  it("skips offboarded businesses, disabled accounts and businesses without an owner email", async () => {
    const off = await tenant({ status: "offboarded" });
    const disabled = await tenant({ disabledAccount: true });
    const noEmail = await tenant({ ownerEmail: null });
    for (const t of [off, disabled, noEmail]) await request(t, { attempt: 1, sentAt: NOV("05T15:00:00Z") });
    await run();
    for (const t of [off, disabled, noEmail]) expect(to(email, t.locationId)).toHaveLength(0);
  });
});
