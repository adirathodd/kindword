// Runs against the Postgres in DATABASE_URL. Fake data only: 555-01xx numbers, example.test emails.
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import { importCsv, importRows } from "./importCsv";
import { normalizePhone, parseTime } from "./normalize";

const HEADER = "name,phone,email,visit_time,consent_method,consent_date,evidence_ref";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");
const CONSENT = "signed estimate,2026-11-01,estimate-0001.pdf";

const businessIds: string[] = [];
async function makeTenant(name: string) {
  const [b] = await db.insert(s.businesses).values({ name, vertical: "plumbing" }).returning();
  businessIds.push(b.id);
  const [l] = await db
    .insert(s.locations)
    .values({ businessId: b.id, name: "Main", timezone: "America/New_York", reviewLink: "https://g.page/r/test" })
    .returning();
  const [a] = await db
    .insert(s.consentAttestations)
    .values({ businessId: b.id, signedAt: new Date(), documentRef: "attest.pdf", listDescription: "signed estimates" })
    .returning();
  return { locationId: l.id, ctx: { attestationId: a.id, consentWordingVersion: "v1" } };
}

let t: Awaited<ReturnType<typeof makeTenant>>;
const run = (text: string, ctx = t.ctx) => importCsv(t.locationId, text, ctx);
const customersOf = () => db.select().from(s.customers).where(eq(s.customers.locationId, t.locationId));
const visitsOf = () => db.select().from(s.visits).where(eq(s.visits.locationId, t.locationId));

// The fixtures use fixed 2026 visit dates; the importer refuses visits more than 12 months old (customer
// retention), so the clock is pinned (Date only; timers stay real) to keep these tests from expiring.
const PINNED_NOW = new Date("2026-11-26T12:00:00Z");
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: PINNED_NOW });
});
beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
beforeEach(async () => {
  t = await makeTenant("Test Plumbing");
});
afterAll(async () => {
  vi.useRealTimers();
  if (businessIds.length) await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds));
  await db.$client.end();
});

describe("importCsv", () => {
  it("inserts a valid row with consent and stores the full consent record", async () => {
    const r = await run(csv(`Pat Doe,(201) 555-0100,Pat@Example.test,2026-11-20 14:30,${CONSENT}`));
    expect(r).toEqual({ ok: true, rows: [{ row: 2, status: "inserted", reason: "ok" }] });
    const [c] = await customersOf();
    expect(c).toMatchObject({
      normalizedPhone: "+12015550100",
      normalizedEmail: "pat@example.test",
      consentMethod: "signed_estimate",
      consentWordingVersion: "v1",
      consentEvidenceRef: "estimate-0001.pdf",
      attestationId: t.ctx.attestationId,
    });
    expect(c.consentAt).toEqual(new Date("2026-11-01T04:00:00Z")); // local midnight, EDT
    const [v] = await visitsOf();
    expect(v).toMatchObject({ customerId: c.id, source: "csv", visitAt: new Date("2026-11-20T19:30:00Z") }); // EST
  });

  it("drops a phone without consent and keeps the row for email", async () => {
    const r = await run(csv("Pat Doe,201-555-0101,pat@example.test,2026-11-20 14:30,,,"));
    expect(r).toEqual({ ok: true, rows: [{ row: 2, status: "inserted", reason: "phone_dropped_no_consent" }] });
    const [c] = await customersOf();
    expect(c).toMatchObject({
      phone: null,
      normalizedPhone: null,
      consentMethod: null,
      normalizedEmail: "pat@example.test",
    });
  });

  it("treats a partial or future consent record as no consent", async () => {
    const r = await run(
      csv(
        "A,201-555-0102,a@example.test,2026-11-20 14:30,signed estimate,2026-11-01,", // no evidence
        "B,201-555-0103,b@example.test,2026-11-20 14:30,carrier pigeon,2026-11-01,e.pdf", // unknown method
        "C,201-555-0104,c@example.test,2026-11-20 14:30,web form,2099-01-01,e.pdf", // future date
      ),
    );
    expect(r.ok && r.rows.map((x) => x.reason)).toEqual(Array(3).fill("phone_dropped_no_consent"));
    expect((await customersOf()).every((c) => c.phone === null)).toBe(true);
  });

  it("rejects a phone without consent and no email", async () => {
    const r = await run(csv("Pat Doe,201-555-0105,,2026-11-20 14:30,,,"));
    expect(r).toEqual({ ok: true, rows: [{ row: 2, status: "rejected", reason: "no_consent_no_email" }] });
    expect(await customersOf()).toHaveLength(0);
  });

  it("rejects invalid phones, emails, visit times and rows with no contact", async () => {
    const r = await run(
      csv(
        `A,201-555-01,a@example.test,2026-11-20 14:30,${CONSENT}`,
        `B,201-555-0106,not-an-email,2026-11-20 14:30,${CONSENT}`,
        `C,201-555-0107,,2026-02-30 14:30,${CONSENT}`,
        `D,,,2026-11-20 14:30,${CONSENT}`,
      ),
    );
    expect(r.ok && r.rows.map((x) => x.reason)).toEqual([
      "invalid_phone",
      "invalid_email",
      "invalid_visit_time",
      "no_contact",
    ]);
    expect(await customersOf()).toHaveLength(0);
  });

  it("rejects a visit more than 12 months old (customer retention) and keeps a newer one", async () => {
    // PINNED_NOW is 2026-11-26 12:00 UTC, so the cutoff is 2025-11-26 12:00 UTC (07:00 in New York).
    const r = await run(
      csv(
        `A,201-555-0123,a@example.test,2025-11-26 07:00,${CONSENT}`, // exactly 12 months: past the window
        "B,,b@example.test,2024-03-01 10:00,,,",
        "C,,c@example.test,2025-11-26 07:01,,,", // one minute inside the window
      ),
    );
    expect(r.ok && r.rows.map((x) => `${x.status}:${x.reason}`)).toEqual([
      "rejected:visit_past_retention",
      "rejected:visit_past_retention",
      "inserted:ok",
    ]);
    expect((await customersOf()).map((c) => c.normalizedEmail)).toEqual(["c@example.test"]);
  });

  it("skips a duplicate phone and a duplicate email in one file", async () => {
    const r = await run(
      csv(
        `A,201-555-0108,a@example.test,2026-11-20 14:30,${CONSENT}`,
        `B,+1 (201) 555-0108,b@example.test,2026-11-20 15:30,${CONSENT}`, // same phone, other format
        `C,201-555-0109,A@EXAMPLE.TEST,2026-11-20 16:30,${CONSENT}`, // same email, other case
      ),
    );
    expect(r.ok && r.rows.map((x) => `${x.status}:${x.reason}`)).toEqual([
      "inserted:ok",
      "skipped:duplicate_in_file",
      "skipped:duplicate_in_file",
    ]);
    expect(await customersOf()).toHaveLength(1);
  });

  it("is idempotent when the same file is imported again", async () => {
    const file = csv(
      `A,201-555-0110,a@example.test,2026-11-20 14:30,${CONSENT}`,
      "B,201-555-0111,b@example.test,2026-11-20 15:30,,,",
    );
    await run(file);
    const again = await run(file);
    expect(again.ok && again.rows.map((x) => x.reason)).toEqual(["duplicate_visit", "duplicate_visit"]);
    expect(await customersOf()).toHaveLength(2);
    expect(await visitsOf()).toHaveLength(2);
  });

  it("adds a new visit to an existing customer without changing the customer", async () => {
    await run(csv("A,,a@example.test,2026-11-20 14:30,,,"));
    const r = await run(csv(`A,201-555-0112,a@example.test,2026-11-21 14:30,${CONSENT}`));
    expect(r.ok && r.rows[0].reason).toBe("existing_customer");
    const [c] = await customersOf();
    expect(c.phone).toBeNull();
    expect(await visitsOf()).toHaveLength(2);
  });

  it("rejects a row whose phone and email belong to different customers", async () => {
    await run(
      csv(`A,201-555-0113,a@example.test,2026-11-20 14:30,${CONSENT}`, "B,,b@example.test,2026-11-20 14:30,,,"),
    );
    const r = await run(csv(`X,201-555-0113,b@example.test,2026-11-22 14:30,${CONSENT}`));
    expect(r.ok && r.rows[0].reason).toBe("contact_conflict");
  });

  it("matches an existing customer on a dropped phone instead of creating a second customer", async () => {
    await run(csv(`A,201-555-0119,,2026-11-20 14:30,${CONSENT}`));
    const r = await run(csv("A,201-555-0119,new@example.test,2026-11-21 14:30,,,"));
    expect(r.ok && r.rows[0]).toMatchObject({ status: "inserted" });
    expect(await customersOf()).toHaveLength(1);
    expect(await visitsOf()).toHaveLength(2);
  });

  it("does not let a rejected row block a later valid row with the same contact", async () => {
    await run(
      csv(`A,201-555-0120,a@example.test,2026-11-20 14:30,${CONSENT}`, "B,,b@example.test,2026-11-20 14:30,,,"),
    );
    const r = await run(
      csv(`X,201-555-0120,b@example.test,2026-11-22 14:30,${CONSENT}`, "B,,b@example.test,2026-11-22 15:30,,,"),
    );
    expect(r.ok && r.rows.map((x) => x.reason)).toEqual(["contact_conflict", "existing_customer"]);
  });

  it("rejects a non-UUID location id without a database error", async () => {
    await expect(importCsv("not-a-uuid", csv(), t.ctx)).rejects.toThrow(/Invalid UUID/);
  });

  it("rejects every row when the attestation belongs to another business", async () => {
    const other = await makeTenant("Other HVAC");
    const r = await run(
      csv(`A,201-555-0114,a@example.test,2026-11-20 14:30,${CONSENT}`, "B,,b@example.test,2026-11-20 14:30,,,"),
      other.ctx,
    );
    expect(r.ok && r.rows.map((x) => x.reason)).toEqual(["attestation_invalid", "attestation_invalid"]);
    expect(await customersOf()).toHaveLength(0);
  });

  it("rejects a malformed CSV without importing anything", async () => {
    const unclosed = await run(
      csv(`A,201-555-0115,a@example.test,2026-11-20 14:30,${CONSENT}`, `"B,,b@example.test,2026-11-20 14:30,,,`),
    );
    expect(unclosed).toMatchObject({ ok: false, error: "malformed_csv" });
    const ragged = await run(csv(`A,201-555-0116,a@example.test,2026-11-20 14:30,${CONSENT}`, "B,,b@example.test"));
    expect(ragged).toEqual({ ok: false, error: "malformed_csv", row: 3 });
    const noCols = await run("name,phone\nA,201-555-0117");
    expect(noCols).toEqual({
      ok: false,
      error: "missing_columns",
      columns: ["email", "visit_time", "consent_method", "consent_date", "evidence_ref"],
    });
    const dupCols = await run(
      `${HEADER},phone\nA,201-555-0121,a@example.test,2026-11-20 14:30,${CONSENT},201-555-0122`,
    );
    expect(dupCols).toEqual({ ok: false, error: "malformed_csv", row: 1 });
    expect(await customersOf()).toHaveLength(0);
  });

  it("never puts contact data in results", async () => {
    const r = await run(
      csv(
        `Pat Doe,201-555-0118,pat@example.test,2026-11-20 14:30,${CONSENT}`,
        "Pat Doe,201-555-01,x@example.test,2026-11-20 14:30,,,",
      ),
    );
    expect(JSON.stringify(r)).not.toMatch(/555|example\.test|Pat/);
  });
});

// SPEC FR-20 and Security: nothing more is collected for an offboarded business. Onboarding (S-5, open) and paused
// still import, as before.
describe("importCsv for an offboarded business", () => {
  const ROW = `Pat Doe,201-555-0130,pat@example.test,2026-11-20 14:30,${CONSENT}`;
  const location = async () => (await db.select().from(s.locations).where(eq(s.locations.id, t.locationId)))[0];
  const setStatus = async (status: (typeof s.businessStatus.enumValues)[number]) =>
    db
      .update(s.businesses)
      .set({ status })
      .where(eq(s.businesses.id, (await location()).businessId));

  it("refuses the whole upload and stores nothing", async () => {
    await setStatus("offboarded");
    expect(await run(csv(ROW))).toEqual({ ok: false, error: "business_offboarded" });
    expect(await customersOf()).toHaveLength(0);
    expect(await visitsOf()).toHaveLength(0);
  });

  it("refuses before parsing, so a malformed file gives the same answer", async () => {
    await setStatus("offboarded");
    expect(await run("name,phone\nA,201-555-0131")).toEqual({ ok: false, error: "business_offboarded" });
  });

  it("still imports for live, paused and onboarding businesses", async () => {
    for (const [i, status] of (["live", "paused", "onboarding"] as const).entries()) {
      await setStatus(status);
      const r = await run(csv(`P${i},201-555-014${i},p${i}@example.test,2026-11-20 14:30,${CONSENT}`));
      expect(r).toEqual({ ok: true, rows: [{ row: 2, status: "inserted", reason: "ok" }] });
    }
    expect(await customersOf()).toHaveLength(3);
  });

  it("imports again once the business is switched back from offboarded", async () => {
    await setStatus("offboarded");
    expect(await run(csv(ROW))).toMatchObject({ ok: false });
    await setStatus("live");
    expect(await run(csv(ROW))).toEqual({ ok: true, rows: [{ row: 2, status: "inserted", reason: "ok" }] });
  });

  it("re-checks every row, so rows after an offboarding are rejected", async () => {
    const loc = await location(); // taken while the business is still onboarding
    await setStatus("offboarded");
    const rows = [
      { row: 2, raw: { ...rawOf(ROW) } },
      { row: 3, raw: { ...rawOf(`Sam Roe,,sam@example.test,2026-11-20 15:00,,,`) } },
    ];
    expect(await importRows(loc, rows, t.ctx, "csv")).toEqual([
      { row: 2, status: "rejected", reason: "business_offboarded" },
      { row: 3, status: "rejected", reason: "business_offboarded" },
    ]);
    expect(await customersOf()).toHaveLength(0);
  });

  it("waits for an offboarding in progress and then stores nothing", async () => {
    const other = await db.$client.connect();
    try {
      await other.query("begin");
      await other.query("update businesses set status = 'offboarded' where id = $1", [(await location()).businessId]);
      // The entry check sees the committed status (onboarding); the row's share lock waits for the update.
      const pending = run(csv(ROW));
      let settled = false;
      void pending.then(() => (settled = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await other.query("commit");
      expect(await pending).toEqual({
        ok: true,
        rows: [{ row: 2, status: "rejected", reason: "business_offboarded" }],
      });
    } finally {
      await other.query("rollback"); // no-op after the commit; frees the row lock if an assertion failed first
      other.release();
    }
    expect(await customersOf()).toHaveLength(0);
  });

  it("does not block an import for another business while one is offboarded", async () => {
    await setStatus("offboarded");
    const mine = t;
    t = await makeTenant("Other Plumbing");
    expect(await run(csv(ROW))).toEqual({ ok: true, rows: [{ row: 2, status: "inserted", reason: "ok" }] });
    t = mine;
    expect(await customersOf()).toHaveLength(0);
  });
});

const rawOf = (line: string) => Object.fromEntries(HEADER.split(",").map((h, i) => [h, line.split(",")[i] ?? ""]));

describe("normalizePhone", () => {
  it.each([
    ["(201) 555-0100", "+12015550100"],
    ["201.555.0100", "+12015550100"],
    ["1-201-555-0100", "+12015550100"],
    ["+1 201 555 0100", "+12015550100"],
    ["201-555-010", null],
    ["101-555-0100", null], // area code can't start with 1
    ["201-155-0100", null], // exchange can't start with 1
    ["+44 20 7946 0958", null],
    ["+2015550100", null], // a "+" without country code 1 is not US
    ["201-555-0100 ext 2", null],
  ])("%s -> %s", (raw, out) => expect(normalizePhone(raw)).toBe(out));
});

describe("parseTime", () => {
  const ny = "America/New_York";
  it("reads naive times in the location's zone across DST", () => {
    expect(parseTime("2026-07-01 09:00", ny)).toEqual(new Date("2026-07-01T13:00:00Z"));
    expect(parseTime("2026-12-01 09:00", ny)).toEqual(new Date("2026-12-01T14:00:00Z"));
    expect(parseTime("2026-11-01 01:30", ny)?.toISOString()).toMatch(/^2026-11-01T0[56]:30/); // ambiguous fall-back hour
  });
  it("honors explicit offsets and rejects junk", () => {
    expect(parseTime("2026-11-20T14:30:00-05:00", ny)).toEqual(new Date("2026-11-20T19:30:00Z"));
    expect(parseTime("11/20/2026", ny)).toBeNull();
    expect(parseTime("2026-11-20 24:00", ny)).toBeNull();
    expect(parseTime("2026-11-20T14:30:00.5Z", ny)).toEqual(new Date("2026-11-20T14:30:00.500Z"));
    // new Date() would roll these over instead of rejecting them
    expect(parseTime("2026-02-30T10:00:00Z", ny)).toBeNull();
    expect(parseTime("2026-11-20T24:00:00Z", ny)).toBeNull();
    expect(parseTime("2026-11-20T14:30+15:00", ny)).toBeNull();
  });
});
