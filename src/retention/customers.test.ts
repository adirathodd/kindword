// Runs against the Postgres in DATABASE_URL. Fake data only: example.test emails, 555-01xx numbers.
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import { customerRetentionCutoff, purgeExpiredCustomers } from "./customers";
import { RetentionPurgeIncompleteError } from "./incomplete";

const DAY = 24 * 60 * 60 * 1000;
// Real time, so rows other test files leave behind are judged by the same clock; assertions only look at our rows.
const NOW = new Date();
const CUTOFF = customerRetentionCutoff(NOW);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

const businessIds: string[] = [];
let n = 0;
const RUN = crypto.randomUUID().slice(0, 8); // platform-wide suppression rows outlive the test businesses
async function makeLocation() {
  const [b] = await db.insert(s.businesses).values({ name: "Retention Test HVAC", vertical: "hvac" }).returning();
  businessIds.push(b.id);
  const [l] = await db
    .insert(s.locations)
    .values({ businessId: b.id, name: "Main", timezone: "America/New_York", reviewLink: "https://g.page/r/test" })
    .returning();
  return { locationId: l.id, businessId: b.id };
}

type Loc = Awaited<ReturnType<typeof makeLocation>>;
async function customer(loc: Loc, visitTimes: Date[]) {
  const [c] = await db
    .insert(s.customers)
    .values({
      ...loc,
      name: "Pat Example",
      email: `retention-${RUN}-${++n}@example.test`,
      normalizedEmail: `retention-${RUN}-${n}@example.test`,
    })
    .returning();
  const visitIds: string[] = [];
  for (const visitAt of visitTimes) {
    const [v] = await db
      .insert(s.visits)
      .values({ customerId: c.id, locationId: loc.locationId, visitAt, source: "csv", externalVisitId: `v-${++n}` })
      .returning();
    visitIds.push(v.id);
  }
  return { id: c.id, email: c.normalizedEmail!, visitIds };
}

const exists = async (id: string) =>
  (await db.select({ id: s.customers.id }).from(s.customers).where(eq(s.customers.id, id))).length === 1;
const purgeAudits = (id: string) =>
  db
    .select()
    .from(s.auditLog)
    .where(and(eq(s.auditLog.entity, "customer"), eq(s.auditLog.entityId, id), eq(s.auditLog.action, "purged")));

beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
afterAll(async () => {
  await db.delete(s.suppressionList).where(like(s.suppressionList.address, `retention-${RUN}-%`));
  if (businessIds.length) await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds));
  await db.$client.end();
});

describe("customerRetentionCutoff", () => {
  it.each([
    ["2026-11-26T12:00:00.000Z", "2025-11-26T12:00:00.000Z"],
    ["2026-03-31T00:00:00.000Z", "2025-03-31T00:00:00.000Z"],
    ["2028-02-29T09:30:00.000Z", "2027-03-01T09:30:00.000Z"], // no Feb 29 in 2027
  ])("%s -> %s", (now, cutoff) => expect(customerRetentionCutoff(new Date(now)).toISOString()).toBe(cutoff));
});

describe("purgeExpiredCustomers", () => {
  it("deletes a customer whose last visit is over 12 months old, with visits and requests, and audits it", async () => {
    const loc = await makeLocation();
    const old = await customer(loc, [daysAgo(400), daysAgo(380)]);
    const [rr] = await db
      .insert(s.reviewRequests)
      .values({ visitId: old.visitIds[1], scheduledFor: daysAgo(380), channel: "email", attempt: 1, status: "sent" })
      .returning();
    // An opt-out for this customer's address must survive the deletion (FR-8: future imports stay blocked).
    await db.insert(s.suppressionList).values([
      { locationId: loc.locationId, channel: "email", address: old.email, source: "test" },
      { locationId: null, channel: "email", address: old.email, source: "test" },
    ]);

    const r = await purgeExpiredCustomers({ now: NOW });
    expect(r.cutoff).toEqual(CUTOFF);
    expect(r.customers).toBeGreaterThanOrEqual(1);

    expect(await exists(old.id)).toBe(false);
    expect(await db.select().from(s.visits).where(inArray(s.visits.id, old.visitIds))).toHaveLength(0);
    expect(await db.select().from(s.reviewRequests).where(eq(s.reviewRequests.id, rr.id))).toHaveLength(0);
    const kept = await db.select().from(s.suppressionList).where(eq(s.suppressionList.address, old.email));
    expect(kept).toHaveLength(2);

    const audits = await purgeAudits(old.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      locationId: loc.locationId,
      actor: "system:retention",
      detail: "reason=retention_12m",
    });
    // IDs and reason only: no name, email or phone in the audit row.
    expect(JSON.stringify(audits)).not.toMatch(/@|Pat|555/);
  });

  it("keeps a customer with any visit inside the 12 months", async () => {
    const loc = await makeLocation();
    const recent = await customer(loc, [daysAgo(330)]);
    const returning = await customer(loc, [daysAgo(500), daysAgo(10)]); // an old visit and a recent one
    await purgeExpiredCustomers({ now: NOW });
    expect(await exists(recent.id)).toBe(true);
    expect(await exists(returning.id)).toBe(true);
    expect(await db.select().from(s.visits).where(inArray(s.visits.id, returning.visitIds))).toHaveLength(2);
    expect(await purgeAudits(returning.id)).toHaveLength(0);
  });

  it("treats a last visit exactly at the cutoff as expired and one millisecond later as kept", async () => {
    const loc = await makeLocation();
    const atCutoff = await customer(loc, [CUTOFF]);
    const justInside = await customer(loc, [new Date(CUTOFF.getTime() + 1)]);
    await purgeExpiredCustomers({ now: NOW });
    expect(await exists(atCutoff.id)).toBe(false);
    expect(await exists(justInside.id)).toBe(true);
  });

  it("is idempotent: a second run deletes nothing more and writes no second audit row", async () => {
    const loc = await makeLocation();
    const old = await customer(loc, [daysAgo(800)]);
    const keep = await customer(loc, [daysAgo(1)]);
    await purgeExpiredCustomers({ now: NOW });
    const again = await purgeExpiredCustomers({ now: NOW });
    expect(again.customers).toBe(0);
    expect(await purgeAudits(old.id)).toHaveLength(1);
    expect(await exists(keep.id)).toBe(true);
  });

  it("only deletes per the visit dates, in every location", async () => {
    const a = await makeLocation();
    const b = await makeLocation();
    const oldA = await customer(a, [daysAgo(366 + 30)]);
    const oldB = await customer(b, [daysAgo(366 + 30)]);
    const newB = await customer(b, [daysAgo(2)]);
    await purgeExpiredCustomers({ now: NOW });
    expect([await exists(oldA.id), await exists(oldB.id), await exists(newB.id)]).toEqual([false, false, true]);
  });

  it("waits for an import holding the location lock and keeps a customer that just got a new visit", async () => {
    const loc = await makeLocation();
    const old = await customer(loc, [daysAgo(400)]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockHeld = new Promise<void>((r) => (locked = r));
    // Stands in for importCsv: the same advisory lock, then a new visit for the existing customer.
    const importing = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${loc.locationId}))`);
      await tx.insert(s.visits).values({
        customerId: old.id,
        locationId: loc.locationId,
        visitAt: NOW,
        source: "csv",
        externalVisitId: "new",
      });
      locked();
      await gate;
    });
    await lockHeld;
    const purging = purgeExpiredCustomers({ now: NOW });
    await new Promise((r) => setTimeout(r, 200)); // the purge is now waiting on the lock
    release();
    await importing;
    await purging;
    expect(await exists(old.id)).toBe(true);
    expect(await purgeAudits(old.id)).toHaveLength(0);
  });

  // Audit O-59-1: one location whose delete fails must not keep every other location's customers past 12 months.
  it("purges the other locations when one fails, then reports the failure and purges it on a later run", async () => {
    const bad = await makeLocation();
    const good = await makeLocation();
    const stuck = await customer(bad, [daysAgo(400)]);
    const other = await customer(good, [daysAgo(400)]);
    const fn = `test_block_customer_delete_${RUN}`;
    // A database error on deleting this location's customers only; the message quotes the customer's fake email.
    await db.execute(
      sql.raw(`create function ${fn}() returns trigger language plpgsql as $$ begin
        if old.location_id = '${bad.locationId}' then raise exception 'blocked %', old.normalized_email; end if;
        return old; end $$;
        create trigger ${fn} before delete on customers for each row execute function ${fn}();`),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = await purgeExpiredCustomers({ now: NOW }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RetentionPurgeIncompleteError);
      expect(err).toMatchObject({ purge: "customers", failed: 1 });
      expect((err as RetentionPurgeIncompleteError).deleted).toBeGreaterThanOrEqual(1);

      expect(await exists(other.id)).toBe(false);
      expect(await purgeAudits(other.id)).toHaveLength(1);
      expect(await exists(stuck.id)).toBe(true);
      expect(await purgeAudits(stuck.id)).toHaveLength(0);

      const lines = errors.mock.calls.map((c) => c.join(" "));
      expect(lines).toContain(`retention: location failed id=${bad.locationId} error=P0001`);
      expect(lines.join("\n") + (err as Error).message).not.toMatch(/example\.test|blocked/);
    } finally {
      errors.mockRestore();
      await db.execute(sql.raw(`drop trigger if exists ${fn} on customers; drop function if exists ${fn}();`));
    }

    await purgeExpiredCustomers({ now: NOW });
    expect(await exists(stuck.id)).toBe(false);
    expect(await purgeAudits(stuck.id)).toHaveLength(1);
  });
});
