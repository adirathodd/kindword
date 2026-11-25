// End-to-end tests of owner accounts (SPEC FR-24) through the real route handlers, against the Postgres in
// DATABASE_URL. Fake data only: @acct.example.test emails, a fake email provider and a fake breach checker.
import { eq, inArray, like } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { routeDeps } from "../../accounts/http";
import { db } from "../../db/client";
import * as s from "../../db/schema";
import type { EmailMessage } from "../../email/provider";
import * as inbox from "../inbox/route";
import * as openInbox from "./inbox/[locationId]/route";
import * as register from "./register/route";
import * as resetReq from "./reset/route";
import * as reset from "./reset/[token]/route";
import * as home from "./route";
import * as signIn from "./sign-in/route";
import * as verify from "./verify/[token]/route";

const BASE = "https://reviews.example.test";
const PW = "a long good password";
const ctx = <K extends string>(key: K, value: string) =>
  ({ params: Promise.resolve({ [key]: value }) }) as unknown as RouteContext<never>;
let ip = 0;
const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`${BASE}/x`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE,
      "x-real-ip": `10.0.0.${ip}`,
      ...headers,
    },
    body: new URLSearchParams(fields),
  });
const get = (cookie = "") => new Request(`${BASE}/x`, { headers: cookie ? { cookie } : {} });
const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0];
const linkIn = (m: EmailMessage, path: string) => new RegExp(`${BASE}${path}/([\\w-]{43})`).exec(m.text)![1];

let sent: EmailMessage[];
let breached: Set<string>;
beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
beforeEach(() => {
  ip++;
  sent = [];
  breached = new Set();
  vi.stubEnv("APP_BASE_URL", BASE);
  vi.stubEnv("SIGNUP_OPEN", "true");
  vi.spyOn(routeDeps, "make").mockImplementation(() => ({
    email: { send: async (m: EmailMessage) => void sent.push(m) },
    breach: { isBreached: async (p: string) => breached.has(p) },
    baseUrl: BASE,
    operatorEmail: "ops@acct.example.test",
  }));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const accts = await db
    .select({ b: s.ownerAccounts.businessId })
    .from(s.ownerAccounts)
    .where(like(s.ownerAccounts.normalizedEmail, "%@acct.example.test"));
  if (accts.length)
    await db.delete(s.businesses).where(
      inArray(
        s.businesses.id,
        accts.map((a) => a.b),
      ),
    );
  await db.delete(s.authAttempts);
});
afterAll(() => db.$client.end());

const signUpForm = (email: string, extra: Record<string, string> = {}) => ({
  name: "Pat Owner",
  businessName: "Pat Plumbing",
  email,
  password: PW,
  terms: "yes",
  ...extra,
});

// Registers and verifies; returns the account cookie and the business ID.
async function verifiedAccount(email: string) {
  expect((await register.POST(post(signUpForm(email)))).status).toBe(200);
  const token = linkIn(
    sent.find((m) => m.to === email)!,
    "/account/verify",
  );
  const res = await verify.POST(post({}), ctx("token", token));
  const [a] = await db.select().from(s.ownerAccounts).where(eq(s.ownerAccounts.normalizedEmail, email));
  return { cookie: cookieOf(res), businessId: a.businessId, accountId: a.id };
}

describe("sign-up", () => {
  it("is closed unless SIGNUP_OPEN=true", async () => {
    vi.stubEnv("SIGNUP_OPEN", "");
    expect(await (await register.GET()).text()).toContain("Sign-up opens soon");
    const res = await register.POST(post(signUpForm("closed@acct.example.test")));
    expect(await res.text()).toContain("Sign-up opens soon");
    expect(
      await db.select().from(s.ownerAccounts).where(eq(s.ownerAccounts.normalizedEmail, "closed@acct.example.test")),
    ).toEqual([]);
  });

  it("creates an onboarding business, emails a verification link and tells the operator", async () => {
    const res = await register.POST(post(signUpForm(" New@Acct.Example.test ")));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Check your email");
    const [a] = await db
      .select()
      .from(s.ownerAccounts)
      .where(eq(s.ownerAccounts.normalizedEmail, "new@acct.example.test"));
    expect(a.passwordHash).toMatch(/^\$argon2id\$/);
    expect(a.emailVerifiedAt).toBeNull();
    expect(a.termsVersion).toBeTruthy();
    const [b] = await db.select().from(s.businesses).where(eq(s.businesses.id, a.businessId));
    expect(b).toMatchObject({ name: "Pat Plumbing", status: "onboarding", ownerEmail: "new@acct.example.test" });
    expect(sent.map((m) => m.to).sort()).toEqual(["new@acct.example.test", "ops@acct.example.test"]);
    expect(sent.every((m) => !m.text.includes(PW))).toBe(true);
  });

  it("answers the same for an email that already has an account, without a second account", async () => {
    await register.POST(post(signUpForm("dup@acct.example.test")));
    sent = [];
    const res = await register.POST(post(signUpForm("dup@acct.example.test", { businessName: "Other" })));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Check your email");
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("Someone tried to create");
    expect(
      await db.select().from(s.ownerAccounts).where(eq(s.ownerAccounts.normalizedEmail, "dup@acct.example.test")),
    ).toHaveLength(1);
  });

  it("rejects short and breached passwords, missing terms, and cross-site posts", async () => {
    breached.add("breached password!");
    for (const [extra, msg] of [
      [{ password: "short" }, "at least 12"],
      [{ password: "breached password!" }, "data breach"],
      [{ terms: "" }, "Accept the terms"],
    ] as const) {
      const res = await register.POST(post(signUpForm("bad@acct.example.test", extra)));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(msg);
    }
    const cross = await register.POST(post(signUpForm("bad@acct.example.test"), { origin: "https://evil.example" }));
    expect(cross.status).toBe(403);
    expect(
      await db.select().from(s.ownerAccounts).where(eq(s.ownerAccounts.normalizedEmail, "bad@acct.example.test")),
    ).toEqual([]);
  });

  it("rate-limits sign-ups per IP", async () => {
    for (let i = 0; i < 5; i++) await register.POST(post(signUpForm(`r${i}@acct.example.test`)));
    expect((await register.POST(post(signUpForm("r5@acct.example.test")))).status).toBe(429);
  });

  // FR-24: sign-up is rate-limited per IP and per email. Without the per-email limit, sign-ups for one address from
  // many IPs each email that address ("Someone tried to create..."), so anyone could flood an owner's inbox.
  it("rate-limits sign-ups per email across IPs, counting case and spacing variants together", async () => {
    const email = "flood@acct.example.test";
    for (let i = 0; i < 5; i++) {
      const variant = i % 2 ? email.toUpperCase() : ` ${email} `;
      const res = await register.POST(post(signUpForm(variant), { "x-real-ip": `10.3.0.${i}` }));
      expect(res.status).toBe(200); // the first creates the account; the rest get the "already has one" note
    }
    expect(sent.filter((m) => m.to === email)).toHaveLength(5);
    const res = await register.POST(post(signUpForm(email), { "x-real-ip": "10.4.0.1" }));
    expect(res.status).toBe(429);
    expect(sent.filter((m) => m.to === email)).toHaveLength(5); // nothing more reaches the owner
  });

  it("the per-email sign-up limit does not block other emails from the same IP", async () => {
    for (let i = 0; i < 5; i++)
      await register.POST(post(signUpForm("busy@acct.example.test"), { "x-real-ip": `10.5.0.${i}` }));
    const res = await register.POST(post(signUpForm("other@acct.example.test"), { "x-real-ip": "10.5.0.1" }));
    expect(res.status).toBe(200);
  });
});

describe("verification and sign-in", () => {
  it("cannot sign in before verifying; a scanner GET does not use the link; POST verifies and signs in", async () => {
    await register.POST(post(signUpForm("v@acct.example.test")));
    const early = await signIn.POST(post({ email: "v@acct.example.test", password: PW }));
    expect(early.status).toBe(403);
    expect(sent.filter((m) => m.to === "v@acct.example.test")).toHaveLength(2); // a fresh link

    const token = linkIn(sent[0], "/account/verify");
    expect((await verify.GET(get(), ctx("token", token))).status).toBe(200);
    const ok = await verify.POST(post({}), ctx("token", token));
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/account");
    expect(ok.headers.get("set-cookie")).toMatch(
      /^account_session=[\w-]{43}; Path=\/account; .*HttpOnly; SameSite=Lax; Secure$/,
    );
    expect((await verify.POST(post({}), ctx("token", token))).status).toBe(400); // single use

    const page = await home.GET(get(cookieOf(ok)));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("We are setting up your account");
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    await verifiedAccount("s@acct.example.test");
    const wrong = await signIn.POST(post({ email: "s@acct.example.test", password: "not the password" }));
    const unknown = await signIn.POST(post({ email: "nobody@acct.example.test", password: "not the password" }));
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const strip = (t: string) => t.replace(/value="[^"]*"/g, "");
    expect(strip(await wrong.text())).toBe(strip(await unknown.text()));

    const good = await signIn.POST(post({ email: "S@acct.example.test", password: PW }));
    expect(good.status).toBe(303);
    expect((await home.GET(get(cookieOf(good)))).status).toBe(200);
  });

  it("rate-limits sign-in attempts per email", async () => {
    await verifiedAccount("lim@acct.example.test");
    for (let i = 0; i < 10; i++)
      await signIn.POST(
        post({ email: "lim@acct.example.test", password: "wrong guess" }, { "x-real-ip": `10.1.0.${i}` }),
      );
    const res = await signIn.POST(post({ email: "lim@acct.example.test", password: PW }, { "x-real-ip": "10.2.0.1" }));
    expect(res.status).toBe(429);
  });

  it("sends a signed-out visitor to the sign-in page", async () => {
    const res = await home.GET(get("account_session=" + "x".repeat(43)));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account/sign-in");
  });
});

describe("password reset", () => {
  it("answers the same for an unknown email and emails nothing", async () => {
    await verifiedAccount("p@acct.example.test");
    sent = [];
    const known = await resetReq.POST(post({ email: "p@acct.example.test" }));
    const unknown = await resetReq.POST(post({ email: "nope@acct.example.test" }));
    expect(await known.text()).toBe(await unknown.text());
    expect(sent.map((m) => m.to)).toEqual(["p@acct.example.test"]);
  });

  it("sets the new password once, ends every other session including inbox ones, and signs this device in", async () => {
    const { cookie, businessId } = await verifiedAccount("q@acct.example.test");
    const [loc] = await db
      .insert(s.locations)
      .values({ businessId, name: "Main", timezone: "America/New_York", reviewLink: "https://g.page/r/t" })
      .returning();
    const inboxCookie = cookieOf(await openInbox.POST(post({}, { cookie }), ctx("locationId", loc.id)));
    expect((await inbox.GET(get(inboxCookie))).status).toBe(200);

    await resetReq.POST(post({ email: "q@acct.example.test" }));
    const token = linkIn(sent.at(-1)!, "/account/reset");
    expect((await reset.GET(get(), ctx("token", token))).status).toBe(200);
    const weak = await reset.POST(post({ password: "short" }), ctx("token", token));
    expect(weak.status).toBe(400); // the token is still usable after a validation error
    const ok = await reset.POST(post({ password: "a brand new password" }), ctx("token", token));
    expect(ok.status).toBe(303);
    expect((await reset.POST(post({ password: "another new password" }), ctx("token", token))).status).toBe(400);

    expect((await home.GET(get(cookie))).status).toBe(303); // old account session ended
    expect((await inbox.GET(get(inboxCookie))).status).toBe(401); // inbox session from the account ended
    expect((await home.GET(get(cookieOf(ok)))).status).toBe(200);
    expect((await signIn.POST(post({ email: "q@acct.example.test", password: PW }))).status).toBe(401);
    expect((await signIn.POST(post({ email: "q@acct.example.test", password: "a brand new password" }))).status).toBe(
      303,
    );
  });
});

describe("opening the inbox", () => {
  it("opens only the account's own locations", async () => {
    const mine = await verifiedAccount("m@acct.example.test");
    const other = await verifiedAccount("o@acct.example.test");
    const [ownLoc, otherLoc] = await db
      .insert(s.locations)
      .values([
        { businessId: mine.businessId, name: "Mine", timezone: "America/New_York", reviewLink: "https://g.page/r/a" },
        {
          businessId: other.businessId,
          name: "Theirs",
          timezone: "America/New_York",
          reviewLink: "https://g.page/r/b",
        },
      ])
      .returning();
    expect(await (await home.GET(get(mine.cookie))).text()).toContain("Open inbox: Mine");

    const ok = await openInbox.POST(post({}, { cookie: mine.cookie }), ctx("locationId", ownLoc.id));
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/inbox");
    const [sess] = await db.select().from(s.ownerSessions).where(eq(s.ownerSessions.locationId, ownLoc.id));
    expect(sess.accountId).toBe(mine.accountId);

    expect((await openInbox.POST(post({}, { cookie: mine.cookie }), ctx("locationId", otherLoc.id))).status).toBe(404);
    expect((await openInbox.POST(post({}, { cookie: mine.cookie }), ctx("locationId", "nope"))).status).toBe(404);
    expect((await openInbox.POST(post({}), ctx("locationId", ownLoc.id))).status).toBe(303); // no session: sign in
  });
});
