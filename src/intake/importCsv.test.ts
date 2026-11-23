// Runs against the Postgres in DATABASE_URL. Fake data only: 555-01xx numbers, example.test emails.
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import { importCsv } from "./importCsv";
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

beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
beforeEach(async () => {
  t = await makeTenant("Test Plumbing");
});
afterAll(async () => {
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
    expect(c).toMatchObject({ phone: null, normalizedPhone: null, consentMethod: null, normalizedEmail: "pat@example.test" });
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
    expect(r.ok && r.rows.map((x) => x.reason)).toEqual(["invalid_phone", "invalid_email", "invalid_visit_time", "no_contact"]);
    expect(await customersOf()).toHaveLength(0);
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
    await run(csv(`A,201-555-0113,a@example.test,2026-11-20 14:30,${CONSENT}`, "B,,b@example.test,2026-11-20 14:30,,,"));
    const r = await run(csv(`X,201-555-0113,b@example.test,2026-11-22 14:30,${CONSENT}`));
    expect(r.ok && r.rows[0].reason).toBe("contact_conflict");
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
    const unclosed = await run(csv(`A,201-555-0115,a@example.test,2026-11-20 14:30,${CONSENT}`, `"B,,b@example.test,2026-11-20 14:30,,,`));
    expect(unclosed).toMatchObject({ ok: false, error: "malformed_csv" });
    const ragged = await run(csv(`A,201-555-0116,a@example.test,2026-11-20 14:30,${CONSENT}`, "B,,b@example.test"));
    expect(ragged).toEqual({ ok: false, error: "malformed_csv", row: 3 });
    const noCols = await run("name,phone\nA,201-555-0117");
    expect(noCols).toEqual({
      ok: false,
      error: "missing_columns",
      columns: ["email", "visit_time", "consent_method", "consent_date", "evidence_ref"],
    });
    expect(await customersOf()).toHaveLength(0);
  });

  it("never puts contact data in results", async () => {
    const r = await run(
      csv(`Pat Doe,201-555-0118,pat@example.test,2026-11-20 14:30,${CONSENT}`, "Pat Doe,201-555-01,x@example.test,2026-11-20 14:30,,,"),
    );
    expect(JSON.stringify(r)).not.toMatch(/555|example\.test|Pat/);
  });
});

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
  });
});
