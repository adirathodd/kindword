// Operator business and location setup (SPEC FR-1, Flow 1 step 1). Runs against the Postgres in DATABASE_URL.
// Fake data only.
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import {
  VERTICALS,
  addLocation,
  createBusinessWithLocation,
  getBusiness,
  listBusinesses,
  parseBusinessInput,
  parseLocationInput,
  updateBusiness,
  updateLocation,
} from "./businesses";

const SESSION = { sessionId: "00000000-0000-4000-8000-000000000001" };
const NOW = new Date("2026-11-26T15:00:00Z");
const businessIds: string[] = [];

const bizFields = (over: Record<string, string | string[]> = {}) => ({
  name: "Garden State Plumbing",
  vertical: "plumbing",
  languages: ["en", "es"],
  toneNotes: "Friendly, first names, never say 'cheap'.",
  approvedFacts: "Call 201-555-0100 to talk to the owner.",
  ...over,
});
const locFields = (over: Record<string, string> = {}) => ({
  name: "Hoboken",
  reviewLink: "https://g.page/r/CAbc123/review",
  timezone: "America/New_York",
  ...over,
});
const field = (o: Record<string, string | string[]>) => (k: string) => {
  const v = o[k];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
};
const fields = (o: Record<string, string | string[]>) => ({
  get: field(o),
  all: (k: string) => {
    const v = o[k];
    return Array.isArray(v) ? v : v === undefined ? [] : [v];
  },
});

async function create(name = "Garden State Plumbing") {
  const b = parseBusinessInput(fields(bizFields({ name })));
  const l = parseLocationInput(fields(locFields()));
  if (!b.ok || !l.ok) throw new Error("bad fixture");
  const r = await createBusinessWithLocation(SESSION, b.value, l.value, { now: NOW });
  businessIds.push(r.businessId);
  return r;
}

beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
afterAll(async () => {
  if (businessIds.length) await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds));
});

describe("parseBusinessInput", () => {
  it("trims and normalizes good input; empty optional text becomes null", () => {
    expect(parseBusinessInput(fields(bizFields({ name: "  Acme  ", toneNotes: "  ", approvedFacts: "" })))).toEqual({
      ok: true,
      value: { name: "Acme", vertical: "plumbing", languages: ["en", "es"], toneNotes: null, approvedFacts: null },
    });
  });

  it("names each bad field", () => {
    const r = parseBusinessInput(
      fields(
        bizFields({
          name: " ",
          vertical: "dentist",
          languages: ["fr"],
          toneNotes: "x".repeat(1001),
          approvedFacts: "x".repeat(2001),
        }),
      ),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(["approvedFacts", "languages", "name", "toneNotes", "vertical"]);
  });

  it("needs at least one language, without duplicates", () => {
    const none = parseBusinessInput(fields(bizFields({ languages: [] })));
    expect(none.ok).toBe(false);
    const dup = parseBusinessInput(fields(bizFields({ languages: ["es", "en", "es"] })));
    expect(dup).toMatchObject({ ok: true, value: { languages: ["en", "es"] } });
  });

  it("offers home-service types only, including the sign-up default", () => {
    expect(VERTICALS.map((v) => v.id)).toContain("home_services");
    for (const v of VERTICALS) expect(parseBusinessInput(fields(bizFields({ vertical: v.id }))).ok).toBe(true);
  });
});

describe("parseLocationInput", () => {
  it("accepts Google review links and IANA time zones", () => {
    for (const reviewLink of [
      "https://g.page/r/CAbc123/review",
      "https://search.google.com/local/writereview?placeid=ChIJ123",
      "https://www.google.com/maps/place/x",
      "https://maps.app.goo.gl/AbC123",
    ])
      expect(parseLocationInput(fields(locFields({ reviewLink }))).ok, reviewLink).toBe(true);
    for (const timezone of ["America/Chicago", "America/Los_Angeles", "Pacific/Honolulu"])
      expect(parseLocationInput(fields(locFields({ timezone }))).ok, timezone).toBe(true);
  });

  it("refuses non-Google or non-https links, unknown time zones and empty names", () => {
    for (const reviewLink of [
      "http://g.page/r/x",
      "https://g.page.evil.example/r/x",
      "https://evil.example/?u=https://g.page",
      "javascript:alert(1)",
      "https://user@g.page/r/x",
      "",
      `https://g.page/${"x".repeat(500)}`,
    ])
      expect(parseLocationInput(fields(locFields({ reviewLink }))), reviewLink).toMatchObject({
        ok: false,
        errors: { reviewLink: expect.any(String) },
      });
    for (const timezone of ["Mars/Base", "EST5EDT; drop", ""])
      expect(parseLocationInput(fields(locFields({ timezone }))), timezone).toMatchObject({
        ok: false,
        errors: { timezone: expect.any(String) },
      });
    expect(parseLocationInput(fields(locFields({ name: "" })))).toMatchObject({
      ok: false,
      errors: { name: expect.any(String) },
    });
  });
});

describe("create and edit", () => {
  it("creates a business in onboarding with its first location, and audits IDs only", async () => {
    const r = await create();
    const b = await getBusiness(r.businessId);
    expect(b).toMatchObject({
      name: "Garden State Plumbing",
      vertical: "plumbing",
      languages: ["en", "es"],
      status: "onboarding",
      toneNotes: "Friendly, first names, never say 'cheap'.",
      approvedFacts: "Call 201-555-0100 to talk to the owner.",
    });
    expect(b!.locations).toEqual([
      expect.objectContaining({
        id: r.locationId,
        name: "Hoboken",
        reviewLink: "https://g.page/r/CAbc123/review",
        timezone: "America/New_York",
      }),
    ]);
    const audit = await db
      .select()
      .from(s.auditLog)
      .where(inArray(s.auditLog.entityId, [r.businessId, r.locationId]));
    expect(audit.map((a) => [a.entity, a.action, a.actor]).sort()).toEqual([
      ["business", "created", `operator_session:${SESSION.sessionId}`],
      ["location", "created", `operator_session:${SESSION.sessionId}`],
    ]);
    for (const a of audit) expect(JSON.stringify(a)).not.toMatch(/Garden|Hoboken|201-555|g\.page/);
  });

  it("edits a business without touching its status, and lists what changed", async () => {
    const r = await create();
    await db.update(s.businesses).set({ status: "live" }).where(eq(s.businesses.id, r.businessId));
    const input = parseBusinessInput(fields(bizFields({ name: "GSP Inc", languages: ["en"] })));
    if (!input.ok) throw new Error("bad");
    expect(await updateBusiness(SESSION, r.businessId, input.value, { now: NOW })).toBe(true);
    expect(await getBusiness(r.businessId)).toMatchObject({ name: "GSP Inc", languages: ["en"], status: "live" });
    const [a] = await db
      .select()
      .from(s.auditLog)
      .where(eq(s.auditLog.entityId, r.businessId))
      .then((rows) => rows.filter((x) => x.action === "updated"));
    expect(a.detail).toBe("fields=name,languages");
  });

  it("adds a location to a business that has none (a self-serve sign-up) and edits it", async () => {
    const [b] = await db
      .insert(s.businesses)
      .values({ name: "Signed Up Roofing", vertical: "home_services" })
      .returning();
    businessIds.push(b.id);
    const l = parseLocationInput(fields(locFields({ name: "Main" })));
    if (!l.ok) throw new Error("bad");
    const id = await addLocation(SESSION, b.id, l.value, { now: NOW });
    expect(id).toEqual(expect.any(String));
    const l2 = parseLocationInput(fields(locFields({ name: "Main office", timezone: "America/Chicago" })));
    if (!l2.ok) throw new Error("bad");
    expect(await updateLocation(SESSION, b.id, id!, l2.value, { now: NOW })).toBe(true);
    expect((await getBusiness(b.id))!.locations).toEqual([
      expect.objectContaining({ id, name: "Main office", timezone: "America/Chicago" }),
    ]);
  });

  it("refuses unknown IDs and a location that belongs to another business", async () => {
    const a = await create("Business A");
    const b = await create("Business B");
    const l = parseLocationInput(fields(locFields()));
    const biz = parseBusinessInput(fields(bizFields()));
    if (!l.ok || !biz.ok) throw new Error("bad");
    const missing = "00000000-0000-4000-8000-00000000dead";
    expect(await getBusiness(missing)).toBeNull();
    expect(await getBusiness("not-a-uuid")).toBeNull();
    expect(await updateBusiness(SESSION, missing, biz.value)).toBe(false);
    expect(await addLocation(SESSION, missing, l.value)).toBeNull();
    expect(await updateLocation(SESSION, b.businessId, a.locationId, l.value)).toBe(false);
    expect((await getBusiness(a.businessId))!.locations[0].name).toBe("Hoboken");
  });

  it("lists every business with its status and location count", async () => {
    const r = await create("Listed Business");
    const rows = await listBusinesses();
    expect(rows.find((x) => x.id === r.businessId)).toEqual({
      id: r.businessId,
      name: "Listed Business",
      vertical: "plumbing",
      status: "onboarding",
      locations: 1,
    });
  });
});
