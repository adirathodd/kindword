// Runs against the Postgres in DATABASE_URL. Fake data only: 555-01xx numbers, example.test emails.
import { generateKeyPairSync } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, type Db } from "../db/client";
import * as s from "../db/schema";
import { importCsv } from "./importCsv";
import { GoogleSheetsReader, SHEETS_API, TOKEN_URL } from "./googleSheets";
import { purgeExpiredCustomers } from "../retention/customers";
import { pollSheet, type SheetReader } from "./pollSheet";

const HEADER = ["row_id", "name", "phone", "email", "visit_time", "consent_method", "consent_date", "evidence_ref"];
const CONSENT = ["signed estimate", "2026-11-01", "estimate-0001.pdf"];
const pat = (id = "1", time = "2026-11-20 14:30") => [
  id,
  "Pat Doe",
  "201-555-0100",
  "pat@example.test",
  time,
  ...CONSENT,
];
const sam = (id = "2") => [id, "Sam Roe", "201-555-0101", "sam@example.test", "2026-11-20 15:00", ...CONSENT];
const lee = (id = "3") => [id, "Lee Poe", "", "lee@example.test", "2026-11-21 09:00", "", "", ""];

// Fake SheetReader: tests mutate `sheet` between polls the way an owner edits the shared sheet.
let sheet: string[][];
const reader: SheetReader = { readRows: async () => sheet.map((r) => [...r]) };

const businessIds: string[] = [];
async function makeTenant() {
  const [b] = await db.insert(s.businesses).values({ name: "Test Plumbing", vertical: "plumbing" }).returning();
  businessIds.push(b.id);
  const [l] = await db
    .insert(s.locations)
    .values({ businessId: b.id, name: "Main", timezone: "America/New_York", reviewLink: "https://g.page/r/test" })
    .returning();
  const [a] = await db
    .insert(s.consentAttestations)
    .values({ businessId: b.id, signedAt: new Date(), documentRef: "attest.pdf", listDescription: "signed estimates" })
    .returning();
  const [src] = await db
    .insert(s.sheetSources)
    .values({ locationId: l.id, sheetId: "fake-sheet", attestationId: a.id, consentWordingVersion: "v1" })
    .returning();
  return { locationId: l.id, sourceId: src.id, ctx: { attestationId: a.id, consentWordingVersion: "v1" } };
}

let t: Awaited<ReturnType<typeof makeTenant>>;
const poll = (d: Db = db) => pollSheet(t.sourceId, reader, d);
const source = async () => (await db.select().from(s.sheetSources).where(eq(s.sheetSources.id, t.sourceId)))[0];
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
  t = await makeTenant();
  sheet = [HEADER, pat(), sam(), lee()];
});
afterAll(async () => {
  vi.useRealTimers();
  if (businessIds.length) await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds));
  await db.$client.end();
});

describe("pollSheet", () => {
  it("imports every row on the first read and records progress", async () => {
    const r = await poll();
    expect(r).toEqual({
      ok: true,
      rows: [
        { row: 2, status: "inserted", reason: "ok" },
        { row: 3, status: "inserted", reason: "ok" },
        { row: 4, status: "inserted", reason: "ok" },
      ],
    });
    const vs = await visitsOf();
    expect(vs.map((v) => [v.source, v.externalVisitId]).sort()).toEqual([
      ["sheet", "1"],
      ["sheet", "2"],
      ["sheet", "3"],
    ]);
    const [c] = (await customersOf()).filter((c) => c.normalizedPhone === "+12015550100");
    expect(c).toMatchObject({ consentWordingVersion: "v1", attestationId: t.ctx.attestationId });
    const src = await source();
    expect(src.lastRowId).toBe("3");
    expect(src.lastReadAt).toBeInstanceOf(Date);
  });

  it("does not bring back a row left in the sheet after its customer was deleted for retention", async () => {
    await poll();
    // A year later the owner's sheet still holds the rows, and the retention job has deleted the customers.
    vi.setSystemTime(new Date("2027-12-01T12:00:00Z"));
    try {
      await purgeExpiredCustomers({ now: new Date() });
      expect(await customersOf()).toHaveLength(0);
      const r = await poll();
      expect(r.ok && r.rows.map((x) => x.reason)).toEqual(Array(3).fill("visit_past_retention"));
      expect(await customersOf()).toHaveLength(0);
    } finally {
      vi.setSystemTime(PINNED_NOW);
    }
  });

  it("imports nothing on a second read with no new rows", async () => {
    await poll();
    const r = await poll();
    expect(r.ok && r.rows.map((x) => x.reason)).toEqual(["duplicate_visit", "duplicate_visit", "duplicate_visit"]);
    expect(await visitsOf()).toHaveLength(3);
  });

  it("imports a row appended later once, and one inserted mid-sheet", async () => {
    await poll();
    sheet.push([
      "4",
      "Kim Moe",
      "201-555-0102",
      "kim@example.test",
      "2026-11-22 10:00",
      "web form",
      "2026-11-02",
      "form-7",
    ]);
    sheet.splice(2, 0, ["0", "Jo Ng", "", "jo@example.test", "2026-11-22 11:00", "", "", ""]); // smaller ID, mid-sheet
    const r1 = await poll();
    expect(r1.ok && r1.rows.filter((x) => x.status === "inserted")).toEqual([
      { row: 3, status: "inserted", reason: "ok" },
      { row: 6, status: "inserted", reason: "ok" },
    ]);
    const r2 = await poll();
    expect(r2.ok && r2.rows.every((x) => x.reason === "duplicate_visit")).toBe(true);
    expect(await visitsOf()).toHaveLength(5);
    expect((await source()).lastRowId).toBe("4");
  });

  it("ignores edits to a row that was already imported", async () => {
    await poll();
    const before = await customersOf();
    sheet[1] = ["1", "Patricia Doe", "201-555-0109", "pat2@example.test", "2026-11-25 08:00", ...CONSENT];
    const r = await poll();
    expect(r.ok && r.rows[0]).toEqual({ row: 2, status: "skipped", reason: "duplicate_visit" });
    expect(await customersOf()).toEqual(before);
    expect(await visitsOf()).toHaveLength(3);
  });

  it("imports each row once when several polls of the same sheet run at once", async () => {
    // Separate pool connections, so the polls really overlap; all read the "already imported" set before any insert.
    const results = await Promise.all(Array.from({ length: 5 }, () => poll()));
    const inserted = results.flatMap((r) => (r.ok ? r.rows : [])).filter((x) => x.status === "inserted");
    expect(inserted.map((x) => x.row).sort()).toEqual([2, 3, 4]);
    expect(results.flatMap((r) => (r.ok ? r.rows : [])).filter((x) => x.status === "rejected")).toEqual([]);
    expect(await visitsOf()).toHaveLength(3);
    expect(await customersOf()).toHaveLength(3);
  });

  it("does not import anything twice after a crash before last_row_id is saved", async () => {
    // Every row commits, then the progress update fails, as if the process died there.
    const crashing = new Proxy(db, {
      get: (target, p) => {
        if (p === "update")
          return () => {
            throw new Error("crash");
          };
        const v = Reflect.get(target, p);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(poll(crashing)).rejects.toThrow("crash");
    expect(await visitsOf()).toHaveLength(3);
    expect((await source()).lastRowId).toBeNull();

    const r = await poll();
    expect(r.ok && r.rows.every((x) => x.reason === "duplicate_visit")).toBe(true);
    expect(await visitsOf()).toHaveLength(3);
    expect((await source()).lastRowId).toBe("3");
  });

  it("dedups a customer and job across a CSV upload and the sheet, in either order", async () => {
    const csv = (time: string) =>
      [HEADER.slice(1).join(","), `Pat Doe,(201) 555-0100,Pat@Example.test,${time},${CONSENT.join(",")}`].join("\n");
    expect(await importCsv(t.locationId, csv("2026-11-20 14:30"), t.ctx)).toEqual({
      ok: true,
      rows: [{ row: 2, status: "inserted", reason: "ok" }],
    });
    sheet = [HEADER, pat("1"), pat("9", "2026-11-23 10:00")];
    const r = await poll();
    expect(r.ok && r.rows).toEqual([
      { row: 2, status: "skipped", reason: "duplicate_visit" }, // same job as the CSV row
      { row: 3, status: "inserted", reason: "existing_customer" }, // a later job for the same customer
    ]);
    // Sheet first, then the same job by CSV.
    const again = await importCsv(t.locationId, csv("2026-11-23 10:00"), t.ctx);
    expect(again).toEqual({ ok: true, rows: [{ row: 2, status: "skipped", reason: "duplicate_visit" }] });
    expect(await customersOf()).toHaveLength(1);
    expect(await visitsOf()).toHaveLength(2);
  });

  it("rejects a sheet missing a required column and leaves progress untouched", async () => {
    sheet = sheet.map((r) => r.filter((_, i) => i !== 6)); // drop consent_date
    expect(await poll()).toEqual({ ok: false, error: "missing_columns", columns: ["consent_date"] });
    sheet = sheet.map((r) => r.slice(1)); // and row_id
    expect(await poll()).toEqual({ ok: false, error: "missing_columns", columns: ["consent_date", "row_id"] });
    expect(await visitsOf()).toHaveLength(0);
    expect(await source()).toMatchObject({ lastRowId: null, lastReadAt: null });
  });

  it("rejects duplicate headers", async () => {
    sheet[0] = [...HEADER.slice(0, -1), "phone"];
    expect(await poll()).toEqual({ ok: false, error: "duplicate_columns" });
  });

  it("refuses to run until the operator sets the consent context", async () => {
    await db.update(s.sheetSources).set({ consentWordingVersion: null }).where(eq(s.sheetSources.id, t.sourceId));
    expect(await poll()).toEqual({ ok: false, error: "not_configured" });
    expect(await visitsOf()).toHaveLength(0);
  });

  // SPEC FR-20: an offboarded client's Sheet is not read and nothing more is stored for it.
  const businessOf = async () =>
    (await db.select().from(s.locations).where(eq(s.locations.id, t.locationId)))[0].businessId;
  const setStatus = async (status: (typeof s.businessStatus.enumValues)[number]) =>
    db
      .update(s.businesses)
      .set({ status })
      .where(eq(s.businesses.id, await businessOf()));

  it("does not read the Sheet of an offboarded business", async () => {
    await setStatus("offboarded");
    const readRows = vi.fn(reader.readRows);
    expect(await pollSheet(t.sourceId, { readRows })).toEqual({ ok: false, error: "business_offboarded" });
    expect(readRows).not.toHaveBeenCalled();
    expect(await customersOf()).toHaveLength(0);
    expect(await source()).toMatchObject({ lastRowId: null, lastReadAt: null });
  });

  it("stores nothing when the business is offboarded while the Sheet is being read", async () => {
    const offboardingReader: SheetReader = {
      readRows: async (id) => {
        await setStatus("offboarded");
        return reader.readRows(id);
      },
    };
    const r = await pollSheet(t.sourceId, offboardingReader);
    expect(r.ok && r.rows.map((x) => x.reason)).toEqual(Array(3).fill("business_offboarded"));
    expect(await customersOf()).toHaveLength(0);
    expect(await visitsOf()).toHaveLength(0);
  });

  it("picks the Sheet up again once the business is switched back", async () => {
    await setStatus("offboarded");
    expect(await poll()).toMatchObject({ ok: false, error: "business_offboarded" });
    await setStatus("live");
    const r = await poll();
    expect(r.ok && r.rows.map((x) => x.status)).toEqual(["inserted", "inserted", "inserted"]);
  });

  it("rejects rows without a row ID, skips repeated IDs, ignores blank rows and short rows", async () => {
    sheet = [
      HEADER,
      ["", ...pat().slice(1)],
      sam("2"),
      [],
      ["2", ...lee().slice(1)],
      ["7", "", "", "x@example.test", "2026-11-20"],
    ];
    const r = await poll();
    expect(r.ok && r.rows).toEqual([
      { row: 2, status: "rejected", reason: "missing_row_id" },
      { row: 3, status: "inserted", reason: "ok" },
      { row: 5, status: "skipped", reason: "duplicate_in_file" },
      { row: 6, status: "inserted", reason: "ok" },
    ]);
  });

  it("retries a rejected row on the next poll once the owner fixes it", async () => {
    sheet = [HEADER, ["5", "Ann Zo", "201-555-0103", "", "2026-11-20 14:30", "", "", ""]]; // phone, no consent, no email
    const r1 = await poll();
    expect(r1.ok && r1.rows[0].reason).toBe("no_consent_no_email");
    sheet[1][3] = "ann@example.test";
    const r2 = await poll();
    expect(r2.ok && r2.rows[0]).toEqual({ row: 2, status: "inserted", reason: "phone_dropped_no_consent" });
  });

  it("imports a repeat customer's second job on the next poll, not never", async () => {
    sheet = [HEADER, pat("1"), pat("2", "2026-11-24 10:00")];
    const r1 = await poll();
    expect(r1.ok && r1.rows[1].reason).toBe("duplicate_in_file"); // one ask per person per read, as in a CSV
    const r2 = await poll();
    expect(r2.ok && r2.rows).toEqual([
      { row: 2, status: "skipped", reason: "duplicate_visit" },
      { row: 3, status: "inserted", reason: "existing_customer" },
    ]);
  });
  it("imports through the Google Sheets reader (fake Google endpoints)", async () => {
    const sheetId = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
    await db.update(s.sheetSources).set({ sheetId }).where(eq(s.sheetSources.id, t.sourceId));
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url === TOKEN_URL) return Response.json({ access_token: "tok", expires_in: 3600 });
      if (url.startsWith(`${SHEETS_API}/${sheetId}/values/`)) return Response.json({ values: sheet });
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const google = new GoogleSheetsReader(
      { clientEmail: "intake@kindword-test.iam.gserviceaccount.com", privateKey },
      { fetchImpl },
    );
    const r = await pollSheet(t.sourceId, google);
    expect(r.ok && r.rows.map((x) => x.status)).toEqual(["inserted", "inserted", "inserted"]);
    expect(urls).toHaveLength(2);
    expect((await source()).lastRowId).toBe("3");
  });
});
