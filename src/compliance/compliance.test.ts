// FR-23 pages through the real route handlers, against the Postgres in DATABASE_URL. Fake data only: example
// businesses and 555-01xx numbers.
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import { GET as optInGet, POST as optInPost } from "../app/sms/[locationId]/route";
import { GET as termsGet } from "../app/sms/[locationId]/terms/route";
import { GET as privacyGet } from "../app/sms/[locationId]/privacy/route";
import { GET as kwTerms } from "../app/terms/route";
import { GET as kwPrivacy } from "../app/privacy/route";
import { OPT_IN_WORDING_VERSION } from "./compliance";
import { TERMS_VERSION } from "../accounts/accounts";

const BASE = "https://reviews.example.test";
const RUN = Date.now().toString(36);
let ip = 0;
const bizIds: string[] = [];
let live: string, onboarding: string, offboarded: string;

async function location(status: "live" | "onboarding" | "offboarded", name = "Example Plumbing") {
  const [b] = await db.insert(s.businesses).values({ name, vertical: "plumbing", status }).returning();
  bizIds.push(b.id);
  const [l] = await db
    .insert(s.locations)
    .values({ businessId: b.id, name, timezone: "America/New_York", reviewLink: "https://g.page/r/example" })
    .returning();
  return l.id;
}

// Route handlers take a typed RouteContext per path; the tests only need params.
type Handler = (req: Request, ctx: never) => Promise<Response>;
const ctx = (locationId: string) => ({ params: Promise.resolve({ locationId }) }) as never;
const get = (fn: Handler, id: string) => fn(new Request(`${BASE}/sms/${id}`), ctx(id));
const post = (id: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  optInPost(
    new Request(`${BASE}/sms/${id}`, {
      method: "POST",
      headers: { origin: BASE, "x-real-ip": `optin-${RUN}-${ip}`, ...headers },
      body: new URLSearchParams(fields),
    }),
    ctx(id),
  );
const optIns = (id: string) => db.select().from(s.smsOptIns).where(eq(s.smsOptIns.locationId, id));

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
  live = await location("live", "Example Plumbing & <Heating>");
  onboarding = await location("onboarding");
  offboarded = await location("offboarded");
});
afterAll(() => db.delete(s.businesses).where(inArray(s.businesses.id, bizIds)));
beforeEach(() => {
  ip++;
  vi.stubEnv("APP_BASE_URL", BASE);
});
afterEach(() => vi.unstubAllEnvs());

describe("per-location pages", () => {
  it.each([
    ["opt-in", optInGet],
    ["terms", termsGet],
    ["privacy", privacyGet],
  ])("%s renders for live and onboarding locations, 404 otherwise", async (_n, fn) => {
    for (const id of [live, onboarding]) expect((await get(fn, id)).status).toBe(200);
    for (const id of [offboarded, "00000000-0000-4000-8000-000000000000", "not-a-uuid"])
      expect((await get(fn, id)).status).toBe(404);
  });

  it("opt-in names the business (escaped), has an unchecked box and the required statements", async () => {
    const body = await (await get(optInGet, live)).text();
    expect(body).toContain("Example Plumbing &amp; &lt;Heating&gt;");
    expect(body).not.toContain("<Heating>");
    expect(body).toMatch(/<input type="checkbox" name="consent" value="yes">/);
    expect(body).not.toMatch(/name="consent"[^>]*checked/);
    expect(body).toContain("Consent is not a condition of any purchase or service");
    expect(body).toContain("at the mobile number I entered above");
    expect(body).toContain("You do not need to sign up to get service");
    expect(body).toContain(`href="/sms/${live}/terms"`);
    expect(body).toContain(`href="/sms/${live}/privacy"`);
    expect(body).toContain(OPT_IN_WORDING_VERSION);
  });

  it("terms list program, frequency, rates, HELP and STOP", async () => {
    const body = await (await get(termsGet, live)).text();
    for (const t of ["review requests", "Up to 2 texts per job", "Msg &amp; data rates may apply", "HELP", "STOP"])
      expect(body).toContain(t);
  });

  it("privacy says numbers and consent are never shared or sold for marketing", async () => {
    const body = await (await get(privacyGet, live)).text();
    // Twilio 30908: non-sharing statement, plus frequency and rates on the policy itself.
    for (const t of [
      "No mobile information will be shared with third parties or affiliates for marketing or promotional purposes",
      "opt-in data and consent will not be shared with any third parties",
      "Up to 2 texts per job",
      "Msg &amp; data rates may apply",
    ])
      expect(body).toContain(t);
    expect(body).not.toMatch(/share[^.]*for (their )?marketing purposes/i);
  });
});

describe("POST opt-in", () => {
  it("records a consent record when the box is checked", async () => {
    const res = await post(onboarding, { phone: "(201) 555-0123", consent: "yes" });
    expect(res.status).toBe(200);
    const rows = await optIns(onboarding);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ normalizedPhone: "+12015550123", consentWordingVersion: OPT_IN_WORDING_VERSION });
    expect(rows[0].consentAt).toBeInstanceOf(Date);
  });

  it.each([
    [{ phone: "201-555-0124" }, "Check the box"],
    [{ phone: "201-555-0124", consent: "on" }, "Check the box"],
    [{ phone: "555-0124", consent: "yes" }, "10-digit"],
    [{ phone: "+44 20 7946 0958", consent: "yes" }, "10-digit"],
  ])("refuses %o and stores nothing", async (fields, msg) => {
    const res = await post(live, fields);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain(msg);
    expect(body).not.toMatch(/name="consent"[^>]*checked/);
    expect(await optIns(live)).toHaveLength(0);
  });

  it("refuses offboarded or unknown locations and cross-site posts", async () => {
    expect((await post(offboarded, { phone: "2015550125", consent: "yes" })).status).toBe(404);
    expect((await post(live, { phone: "2015550125", consent: "yes" }, { origin: "https://evil.example" })).status).toBe(
      403,
    );
    expect(await optIns(live)).toHaveLength(0);
  });

  it("rate-limits one address", async () => {
    for (let i = 0; i < 10; i++)
      expect((await post(onboarding, { phone: `20155501${10 + i}`, consent: "yes" })).status).toBe(200);
    expect((await post(onboarding, { phone: "2015550199", consent: "yes" })).status).toBe(429);
  });

  it("the database refuses a malformed phone or empty wording version", async () => {
    const [l] = await db.select().from(s.locations).where(eq(s.locations.id, live));
    const row = { locationId: live, businessId: l.businessId, consentAt: new Date() };
    await expect(
      db.insert(s.smsOptIns).values({ ...row, normalizedPhone: "2015550123", consentWordingVersion: "v1" }),
    ).rejects.toThrow();
    await expect(
      db.insert(s.smsOptIns).values({ ...row, normalizedPhone: "+12015550123", consentWordingVersion: "" }),
    ).rejects.toThrow();
  });
});

describe("Kindword /terms and /privacy", () => {
  it("render with the version the sign-up records", async () => {
    for (const fn of [kwTerms, kwPrivacy]) {
      const res = fn();
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(TERMS_VERSION);
    }
    const privacy = await kwPrivacy().text();
    expect(privacy).toContain("never sell personal data");
    expect(privacy).toContain("opt-in data and consent will not be shared with any third parties");
    for (const t of ["Limitation of liability", "Governing law", "Acceptable use"])
      expect(await kwTerms().text()).toContain(t);
  });
});
