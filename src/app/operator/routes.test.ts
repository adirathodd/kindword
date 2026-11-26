// End-to-end tests of the operator area (SPEC FR-1, Security: operator password plus two-factor) through the real
// route handlers, against the Postgres in DATABASE_URL. Fake data only.
import { eq, inArray, like } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../../accounts/password";
import { db } from "../../db/client";
import * as s from "../../db/schema";
import { TOTP_PERIOD_S, generateTotpSecret, totpCode } from "../../operator/totp";
import * as location from "./businesses/[id]/locations/[locationId]/route";
import * as locations from "./businesses/[id]/locations/route";
import * as business from "./businesses/[id]/route";
import * as newBusiness from "./businesses/new/route";
import * as home from "./route";
import * as signIn from "./sign-in/route";
import * as signOut from "./sign-out/route";

const BASE = "https://reviews.example.test";
const EMAIL = "ops@operator.example.test";
const PW = "operator route test password";
const TOTP = generateTotpSecret();
const RUN = Math.floor(Math.random() * 250);
let ip = 0;
let step = Math.floor(Date.now() / 1000 / TOTP_PERIOD_S);

const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as unknown as RouteContext<never>;
const post = (fields: Record<string, string | string[]>, headers: Record<string, string> = {}) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  return new Request(`${BASE}/operator/x`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE,
      "x-real-ip": `10.7.${RUN}.${ip}`,
      ...headers,
    },
    body,
  });
};
const get = (cookie = "", path = "/operator/x") => new Request(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0];

// Each sign-in uses the next time step's code, so no code is reused (codes work once).
async function signedIn() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(++step * TOTP_PERIOD_S * 1000 + 1000);
  const res = await signIn.POST(post({ email: EMAIL, password: PW, code: totpCode(TOTP, step) }));
  vi.useRealTimers();
  expect(res.status).toBe(303);
  return cookieOf(res);
}

const bizForm = (over: Record<string, string | string[]> = {}) => ({
  name: "Route Test HVAC",
  vertical: "hvac",
  languages: ["en"],
  toneNotes: "Casual.",
  approvedFacts: "",
  "location.name": "Newark",
  "location.reviewLink": "https://g.page/r/route-test/review",
  "location.timezone": "America/New_York",
  ...over,
});
const created = async (cookie: string, over: Record<string, string | string[]> = {}) => {
  const res = await newBusiness.POST(post(bizForm(over), { cookie }));
  expect(res.status).toBe(303);
  return /\/operator\/businesses\/([0-9a-f-]{36})\?saved=created$/.exec(res.headers.get("location")!)![1];
};

let passwordHash: string;
beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
  passwordHash = await hashPassword(PW);
});
beforeEach(() => {
  ip++;
  vi.stubEnv("APP_BASE_URL", BASE);
  vi.stubEnv("OPERATOR_EMAIL", EMAIL);
  vi.stubEnv("OPERATOR_PASSWORD_HASH", passwordHash);
  vi.stubEnv("OPERATOR_TOTP_SECRET", TOTP);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
afterAll(async () => {
  await db.delete(s.businesses).where(like(s.businesses.name, "Route Test%"));
  await db.delete(s.operatorSessions);
});

describe("operator sign-in", () => {
  it("is off (503) when any operator setting is missing", async () => {
    vi.stubEnv("OPERATOR_TOTP_SECRET", "");
    expect((await signIn.GET()).status).toBe(503);
    expect((await signIn.POST(post({ email: EMAIL, password: PW, code: "123456" }))).status).toBe(503);
  });

  it("sets a strict, HttpOnly, Secure cookie for /operator only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(++step * TOTP_PERIOD_S * 1000 + 1000);
    const res = await signIn.POST(post({ email: EMAIL, password: PW, code: totpCode(TOTP, step) }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/operator");
    const c = res.headers.get("set-cookie")!;
    for (const part of ["Path=/operator", "HttpOnly", "SameSite=Strict", "Secure"]) expect(c).toContain(part);
  });

  it("refuses a wrong code with the same message as a wrong password, and refuses cross-site posts", async () => {
    const wrongCode = await signIn.POST(post({ email: EMAIL, password: PW, code: "000000" }));
    const wrongPw = await signIn.POST(post({ email: EMAIL, password: "nope nope nope", code: "000000" }));
    expect(wrongCode.status).toBe(401);
    expect(await wrongCode.text()).toBe(await wrongPw.text());
    const cross = await signIn.POST(
      post({ email: EMAIL, password: PW, code: "000000" }, { origin: "https://evil.example" }),
    );
    expect(cross.status).toBe(403);
  });

  it("signs out", async () => {
    const cookie = await signedIn();
    expect((await home.GET(get(cookie))).status).toBe(200);
    const out = await signOut.POST(post({}, { cookie }));
    expect(out.headers.get("location")).toBe("/operator/sign-in");
    expect((await home.GET(get(cookie))).status).toBe(303);
  });
});

describe("access control", () => {
  it("sends every operator page and form to sign-in without an operator session, even with an owner cookie", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    for (const cookie of [
      "",
      "account_session=" + "a".repeat(43),
      "owner_session=" + "a".repeat(43),
      "operator_session=x",
    ]) {
      const responses = [
        await home.GET(get(cookie)),
        await newBusiness.GET(get(cookie)),
        await newBusiness.POST(post(bizForm(), { cookie })),
        await business.GET(get(cookie), ctx({ id })),
        await business.POST(post(bizForm(), { cookie }), ctx({ id })),
        await locations.POST(post({}, { cookie }), ctx({ id })),
        await location.POST(post({}, { cookie }), ctx({ id, locationId: id })),
      ];
      for (const r of responses) {
        expect(r.status, cookie).toBe(303);
        expect(r.headers.get("location")).toBe("/operator/sign-in");
      }
    }
    expect(await db.select().from(s.businesses).where(eq(s.businesses.name, "Route Test HVAC"))).toEqual([]);
  });

  it("refuses cross-site form posts even with a valid session", async () => {
    const cookie = await signedIn();
    const r = await newBusiness.POST(post(bizForm(), { cookie, origin: "https://evil.example" }));
    expect(r.status).toBe(403);
  });
});

describe("businesses and locations", () => {
  it("creates a business with its first location, then lists and shows it", async () => {
    const cookie = await signedIn();
    expect((await newBusiness.GET(get(cookie))).status).toBe(200);
    const id = await created(cookie, { name: "Route Test <b>Air</b>" });
    const page = await business.GET(get(cookie, `/operator/businesses/${id}?saved=created`), ctx({ id }));
    const body = await page.text();
    expect(page.status).toBe(200);
    expect(body).toContain("Route Test &lt;b&gt;Air&lt;/b&gt;");
    expect(body).not.toContain("<b>Air</b>");
    expect(body).toContain("Business added.");
    for (const saved of ["constructor", "__proto__", "toString", "<b>x</b>"]) {
      const r = await business.GET(
        get(cookie, `/operator/businesses/${id}?saved=${encodeURIComponent(saved)}`),
        ctx({ id }),
      );
      expect(r.status, saved).toBe(200);
      expect(await r.text()).not.toContain("<b>x</b>");
    }
    expect(body).toContain("https://g.page/r/route-test/review");
    const list = await (await home.GET(get(cookie))).text();
    expect(list).toContain(`/operator/businesses/${id}`);
    expect(list).toContain("Onboarding");
  });

  it("shows field errors and creates nothing for bad input", async () => {
    const cookie = await signedIn();
    const r = await newBusiness.POST(
      post(bizForm({ name: "Route Test Bad", "location.reviewLink": "https://evil.example/r", languages: [] }), {
        cookie,
      }),
    );
    expect(r.status).toBe(400);
    const body = await r.text();
    expect(body).toContain("Google review link");
    expect(body).toContain("Choose English, Spanish or both.");
    expect(body).toContain('value="Route Test Bad"'); // keeps what was typed
    expect(await db.select().from(s.businesses).where(eq(s.businesses.name, "Route Test Bad"))).toEqual([]);
  });

  it("edits the business, adds a location and edits it", async () => {
    const cookie = await signedIn();
    const id = await created(cookie);
    const saved = await business.POST(
      post(bizForm({ name: "Route Test HVAC Co", languages: ["en", "es"] }), { cookie }),
      ctx({ id }),
    );
    expect(saved.headers.get("location")).toBe(`/operator/businesses/${id}?saved=business`);

    const add = await locations.POST(
      post({ name: "Jersey City", reviewLink: "https://g.page/r/jc/review", timezone: "America/New_York" }, { cookie }),
      ctx({ id }),
    );
    expect(add.status).toBe(303);
    const locs = await db.select().from(s.locations).where(eq(s.locations.businessId, id));
    const jc = locs.find((l) => l.name === "Jersey City")!;

    const edit = await location.POST(
      post({ name: "Jersey City", reviewLink: "https://g.page/r/jc2/review", timezone: "America/Chicago" }, { cookie }),
      ctx({ id, locationId: jc.id }),
    );
    expect(edit.status).toBe(303);
    const [row] = await db.select().from(s.locations).where(eq(s.locations.id, jc.id));
    expect(row).toMatchObject({ reviewLink: "https://g.page/r/jc2/review", timezone: "America/Chicago" });
    const [b] = await db.select().from(s.businesses).where(eq(s.businesses.id, id));
    expect(b).toMatchObject({ name: "Route Test HVAC Co", languages: ["en", "es"], status: "onboarding" });
  });

  it("does not let one business's page edit another business's location", async () => {
    const cookie = await signedIn();
    const a = await created(cookie, { name: "Route Test A" });
    const b = await created(cookie, { name: "Route Test B" });
    const [la] = await db.select().from(s.locations).where(eq(s.locations.businessId, a));
    const r = await location.POST(
      post({ name: "Hijacked", reviewLink: "https://g.page/r/x/review", timezone: "America/New_York" }, { cookie }),
      ctx({ id: b, locationId: la.id }),
    );
    expect(r.status).toBe(404);
    const [still] = await db
      .select()
      .from(s.locations)
      .where(inArray(s.locations.id, [la.id]));
    expect(still.name).toBe("Newark");
  });

  it("answers 404 for an unknown or malformed business ID", async () => {
    const cookie = await signedIn();
    for (const id of ["00000000-0000-4000-8000-00000000beef", "nope"])
      expect((await business.GET(get(cookie), ctx({ id }))).status).toBe(404);
  });
});
