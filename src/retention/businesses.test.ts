// Runs against the Postgres in DATABASE_URL. Fake data only: example.test emails, 555-01xx numbers.
import { eq, inArray, like } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import { purgeOffboardedBusinesses } from "./businesses";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);
const RUN = crypto.randomUUID().slice(0, 8); // platform-wide opt-outs outlive the test businesses

const businessIds: string[] = [];
let n = 0;

async function business(status: "onboarding" | "live" | "offboarded" = "live", offboardedAt?: Date) {
  const [b] = await db
    .insert(s.businesses)
    .values({ name: `Offboard Test Roofing ${++n}`, vertical: "roofing", status, offboardedAt })
    .returning();
  businessIds.push(b.id);
  return b;
}
const get = async (id: string) => (await db.select().from(s.businesses).where(eq(s.businesses.id, id)))[0];

// A business with one of everything that hangs off it.
async function fullBusiness(offboardedDaysAgo: number) {
  const b = await business("offboarded", daysAgo(offboardedDaysAgo));
  const [l] = await db
    .insert(s.locations)
    .values({ businessId: b.id, name: "Main", timezone: "America/New_York", reviewLink: "https://g.page/r/test" })
    .returning();
  const [att] = await db
    .insert(s.consentAttestations)
    .values({ businessId: b.id, signedAt: daysAgo(90), documentRef: "attest.pdf", listDescription: "estimates" })
    .returning();
  const phone = `+1201555${String(100 + n).padStart(4, "0")}`;
  const email = `offboard-${RUN}-${n}@example.test`;
  const [c] = await db
    .insert(s.customers)
    .values({
      locationId: l.id,
      businessId: b.id,
      name: "Pat Example",
      phone,
      normalizedPhone: phone,
      email,
      normalizedEmail: email,
      consentMethod: "signed_estimate",
      consentWordingVersion: "v1",
      consentAt: daysAgo(60),
      consentEvidenceRef: "estimate.pdf",
      attestationId: att.id,
    })
    .returning();
  const [v] = await db
    .insert(s.visits)
    .values({ customerId: c.id, locationId: l.id, visitAt: daysAgo(50), source: "csv", externalVisitId: `v-${n}` })
    .returning();
  await db
    .insert(s.reviewRequests)
    .values({ visitId: v.id, scheduledFor: daysAgo(50), channel: "sms", attempt: 1, status: "sent" });
  const [r] = await db
    .insert(s.reviews)
    .values({ locationId: l.id, googleReviewId: `offboard-${RUN}-${n}`, rating: 5, text: "Great roof." })
    .returning();
  await db
    .insert(s.replyDrafts)
    .values({ reviewId: r.id, locationId: l.id, draftText: "Thank you.", model: "test", promptVersion: 1 });
  await db.insert(s.ownerSessions).values({
    locationId: l.id,
    ownerEmail: "owner@example.test",
    loginTokenHash: `offboard-${RUN}-${n}`,
    tokenExpiresAt: NOW,
  });
  await db.insert(s.oauthTokens).values({
    locationId: l.id,
    encryptedRefreshToken: "not-a-real-token",
    scopes: ["https://www.googleapis.com/auth/business.manage"],
  });
  await db.insert(s.sheetSources).values({ locationId: l.id, sheetId: "fake-sheet" });
  await db.insert(s.smsOptIns).values({
    locationId: l.id,
    businessId: b.id,
    normalizedPhone: phone,
    consentWordingVersion: "v1",
    consentAt: daysAgo(60),
  });
  await db.insert(s.ownerAccounts).values({
    businessId: b.id,
    name: "Owner",
    email: `owner-${RUN}-${n}@example.test`,
    normalizedEmail: `owner-${RUN}-${n}@example.test`,
    passwordHash: "not-a-real-hash",
    termsVersion: "test",
    termsAcceptedAt: daysAgo(90),
  });
  await db.insert(s.suppressionList).values([
    { locationId: l.id, channel: "sms", address: phone, source: "test" },
    { locationId: null, channel: "email", address: email, source: `offboard-${RUN}` },
  ]);
  return { businessId: b.id, locationId: l.id, customerId: c.id, reviewId: r.id, email };
}

beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
afterAll(async () => {
  await db.delete(s.suppressionList).where(like(s.suppressionList.source, `offboard-${RUN}`));
  const left = businessIds.length
    ? await db.select({ id: s.businesses.id }).from(s.businesses).where(inArray(s.businesses.id, businessIds))
    : [];
  if (left.length)
    await db.delete(s.businesses).where(
      inArray(
        s.businesses.id,
        left.map((b) => b.id),
      ),
    );
  await db.$client.end();
});

describe("offboarded_at trigger", () => {
  it("stamps the time when a business becomes offboarded and clears it when it leaves", async () => {
    const b = await business("live");
    expect((await get(b.id)).offboardedAt).toBeNull();

    const before = Date.now();
    await db.update(s.businesses).set({ status: "offboarded" }).where(eq(s.businesses.id, b.id));
    const stamped = (await get(b.id)).offboardedAt!;
    expect(stamped).toBeInstanceOf(Date);
    expect(Math.abs(stamped.getTime() - before)).toBeLessThan(60_000);

    // Another update while offboarded keeps the original time.
    await db.update(s.businesses).set({ name: "Renamed" }).where(eq(s.businesses.id, b.id));
    expect((await get(b.id)).offboardedAt).toEqual(stamped);

    await db.update(s.businesses).set({ status: "live" }).where(eq(s.businesses.id, b.id));
    expect((await get(b.id)).offboardedAt).toBeNull();
  });

  it("stamps an insert straight into offboarded, and never sets the time for other statuses", async () => {
    const off = await business("offboarded");
    expect((await get(off.id)).offboardedAt).toBeInstanceOf(Date);
    const live = await business("live", daysAgo(5)); // a stray value is cleared
    expect((await get(live.id)).offboardedAt).toBeNull();
  });
});

describe("purgeOffboardedBusinesses", () => {
  it("deletes everything for a business offboarded 29 days ago or more, keeping platform-wide opt-outs", async () => {
    const f = await fullBusiness(29);
    const r = await purgeOffboardedBusinesses({ now: NOW });
    expect(r.businesses).toBeGreaterThanOrEqual(1);

    expect(await get(f.businessId)).toBeUndefined();
    const count = async (rows: Promise<unknown[]>) => (await rows).length;
    expect(await count(db.select().from(s.locations).where(eq(s.locations.businessId, f.businessId)))).toBe(0);
    expect(await count(db.select().from(s.customers).where(eq(s.customers.id, f.customerId)))).toBe(0);
    expect(await count(db.select().from(s.reviews).where(eq(s.reviews.id, f.reviewId)))).toBe(0);
    expect(await count(db.select().from(s.replyDrafts).where(eq(s.replyDrafts.locationId, f.locationId)))).toBe(0);
    expect(await count(db.select().from(s.ownerSessions).where(eq(s.ownerSessions.locationId, f.locationId)))).toBe(0);
    expect(await count(db.select().from(s.oauthTokens).where(eq(s.oauthTokens.locationId, f.locationId)))).toBe(0);
    expect(await count(db.select().from(s.sheetSources).where(eq(s.sheetSources.locationId, f.locationId)))).toBe(0);
    expect(await count(db.select().from(s.smsOptIns).where(eq(s.smsOptIns.businessId, f.businessId)))).toBe(0);
    expect(await count(db.select().from(s.ownerAccounts).where(eq(s.ownerAccounts.businessId, f.businessId)))).toBe(0);
    expect(
      await count(db.select().from(s.consentAttestations).where(eq(s.consentAttestations.businessId, f.businessId))),
    ).toBe(0);
    expect(await count(db.select().from(s.suppressionList).where(eq(s.suppressionList.locationId, f.locationId)))).toBe(
      0,
    );
    // The platform-wide opt-out for this customer's email still blocks every other business.
    expect(await count(db.select().from(s.suppressionList).where(eq(s.suppressionList.address, f.email)))).toBe(1);

    const audits = await db.select().from(s.auditLog).where(eq(s.auditLog.entityId, f.businessId));
    expect(audits).toEqual([
      expect.objectContaining({
        entity: "business",
        action: "purged",
        actor: "system:retention",
        detail: "reason=offboarded_30d",
      }),
    ]);
  });

  it("keeps a business offboarded less than 29 days ago, and live or onboarding businesses", async () => {
    const recent = await fullBusiness(27);
    const live = await business("live");
    const onboarding = await business("onboarding");
    await purgeOffboardedBusinesses({ now: NOW });
    expect(await get(recent.businessId)).toBeDefined();
    expect(await get(live.id)).toBeDefined();
    expect(await get(onboarding.id)).toBeDefined();
  });

  it("keeps a business switched back to live before the deadline, even if it was offboarded long ago", async () => {
    const b = await business("offboarded", daysAgo(40));
    await db.update(s.businesses).set({ status: "live" }).where(eq(s.businesses.id, b.id));
    await purgeOffboardedBusinesses({ now: NOW });
    expect(await get(b.id)).toBeDefined();
  });

  it("is idempotent: a second run deletes nothing more and writes no second audit row", async () => {
    const b = await business("offboarded", daysAgo(45));
    await purgeOffboardedBusinesses({ now: NOW });
    const again = await purgeOffboardedBusinesses({ now: NOW });
    expect(again.businesses).toBe(0);
    expect(await db.select().from(s.auditLog).where(eq(s.auditLog.entityId, b.id))).toHaveLength(1);
  });

  it("rejects a margin outside 0 to 30 days", async () => {
    await expect(purgeOffboardedBusinesses({ marginMs: -1 })).rejects.toThrow(/marginMs/);
    await expect(purgeOffboardedBusinesses({ marginMs: 30 * DAY })).rejects.toThrow(/marginMs/);
  });
});
