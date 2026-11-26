// End-to-end tests of "Email me a sign-in link" (SPEC FR-13) through the real route handlers, against the Postgres in
// DATABASE_URL. Fake data only: @link.example.test emails and a fake email provider.
import { createHash } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { routeDeps } from "../../../../accounts/http";
import { db } from "../../../../db/client";
import * as s from "../../../../db/schema";
import type { EmailMessage } from "../../../../email/provider";
import { LINK_LIMITS } from "../../../../inbox/linkRequest";
import * as inbox from "../../../inbox/route";
import * as useLink from "../../../inbox/sign-in/[token]/route";
import * as resetReq from "../../reset/route";
import * as reset from "../../reset/[token]/route";
import * as signIn from "../route";
import * as link from "./route";

const BASE = "https://reviews.example.test";
const ctx = (token: string) =>
  ({ params: Promise.resolve({ token }) }) as unknown as RouteContext<"/inbox/sign-in/[token]">;
let ip = 0;
const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`${BASE}/account/sign-in/link`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE,
      "x-real-ip": `10.1.0.${ip}`,
      ...headers,
    },
    body: new URLSearchParams(fields),
  });
const ask = (email: string, headers: Record<string, string> = {}) => link.POST(post({ email }, headers));
const tokensIn = (m: EmailMessage) =>
  [...m.text.matchAll(new RegExp(`${BASE}/inbox/sign-in/([\\w-]{43})`, "g"))].map((x) => x[1]);

let sent: EmailMessage[];
beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
beforeEach(() => {
  ip++;
  sent = [];
  vi.stubEnv("APP_BASE_URL", BASE);
  vi.spyOn(routeDeps, "make").mockImplementation(() => ({
    email: { send: async (m: EmailMessage) => void sent.push(m) },
    breach: { isBreached: async () => false },
    baseUrl: BASE,
  }));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await db.delete(s.businesses).where(like(s.businesses.ownerEmail, "%@link.example.test"));
  await db.delete(s.authAttempts);
});
afterAll(() => db.$client.end());

// A business the operator set up (no account), with the given locations.
async function business(ownerEmail: string, locs: string[], status: "onboarding" | "live" | "offboarded" = "live") {
  const [b] = await db
    .insert(s.businesses)
    .values({ name: "Pat Plumbing", vertical: "plumbing", ownerEmail, status })
    .returning();
  const rows = locs.length
    ? await db
        .insert(s.locations)
        .values(
          locs.map((name, i) => ({
            businessId: b.id,
            name,
            timezone: "America/New_York",
            reviewLink: `https://g.page/r/${i}`,
          })),
        )
        .returning()
    : [];
  return { businessId: b.id, locations: rows };
}

async function withAccount(businessId: string, email: string, disabled = false) {
  const [a] = await db
    .insert(s.ownerAccounts)
    .values({
      businessId,
      name: "Pat Owner",
      email,
      normalizedEmail: email.toLowerCase(),
      passwordHash: "not-a-real-hash",
      emailVerifiedAt: new Date(),
      termsVersion: "2026-11-23",
      termsAcceptedAt: new Date(),
      disabledAt: disabled ? new Date() : null,
    })
    .returning();
  return a.id;
}

const SAME_ANSWER = "If that email belongs to a Kindword owner";

describe("email me a sign-in link", () => {
  it("is offered on the password sign-in screen", async () => {
    const page = await (await signIn.GET()).text();
    expect(page).toContain('href="/account/sign-in/link"');
    const form = await link.GET();
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('name="email"');
  });

  it("emails a working single-use link that opens only that location's inbox", async () => {
    const { locations } = await business("pat@link.example.test", ["Main"]);
    const res = await ask(" Pat@Link.Example.test ");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SAME_ANSWER);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "pat@link.example.test", fromName: "Kindword" });
    expect(sent[0].subject).toContain("Pat Plumbing");
    expect(sent[0].text).toContain("expires in 15 minutes");
    const [token] = tokensIn(sent[0]);
    expect(token).toBeDefined();
    expect(sent[0].html).toContain(`${BASE}/inbox/sign-in/${token}`);

    const used = await useLink.POST(
      new Request(`${BASE}/inbox/sign-in/${token}`, { method: "POST", headers: { origin: BASE } }),
      ctx(token),
    );
    expect(used.status).toBe(303);
    const cookie = used.headers.get("set-cookie")!.split(";")[0];
    expect((await inbox.GET(new Request(`${BASE}/inbox`, { headers: { cookie } }))).status).toBe(200);
    const [sess] = await db.select().from(s.ownerSessions).where(eq(s.ownerSessions.locationId, locations[0].id));
    expect(sess.sessionTokenHash).not.toBeNull();

    const again = await useLink.POST(
      new Request(`${BASE}/inbox/sign-in/${token}`, { method: "POST", headers: { origin: BASE } }),
      ctx(token),
    );
    expect(again.status).toBe(400); // single use
    expect(await again.text()).toContain('href="/account/sign-in/link"');
  });

  it("sends one email with a separate link per location", async () => {
    const { locations } = await business("multi@link.example.test", ["Uptown", "Downtown"]);
    await ask("multi@link.example.test");
    expect(sent).toHaveLength(1);
    expect(tokensIn(sent[0])).toHaveLength(2);
    expect(sent[0].text.indexOf("Downtown:")).toBeLessThan(sent[0].text.indexOf("Uptown:")); // by name
    const sessions = await db
      .select()
      .from(s.ownerSessions)
      .where(
        inArray(
          s.ownerSessions.locationId,
          locations.map((l) => l.id),
        ),
      );
    expect(sessions.map((x) => x.locationId).sort()).toEqual(locations.map((l) => l.id).sort());
  });

  it("gives the same answer and sends nothing for an unknown email", async () => {
    await business("known@link.example.test", ["Main"]);
    const known = await (await ask("known@link.example.test")).text();
    sent = [];
    const res = await ask("nobody@link.example.test");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(known);
    expect(sent).toHaveLength(0);
  });

  it("sends nothing for an offboarded business, a disabled account, or a business with no location yet", async () => {
    await business("gone@link.example.test", ["Main"], "offboarded");
    const off = await business("disabled@link.example.test", ["Main"]);
    await withAccount(off.businessId, "disabled@link.example.test", true);
    await business("setup@link.example.test", [], "onboarding");
    for (const e of ["gone@link.example.test", "disabled@link.example.test", "setup@link.example.test"]) {
      const res = await ask(e);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(SAME_ANSWER);
    }
    expect(sent).toHaveLength(0);
    expect(await db.select().from(s.ownerSessions).where(eq(s.ownerSessions.locationId, off.locations[0].id))).toEqual(
      [],
    );
  });

  it("ties the session to the owner's account, so a password reset ends it", async () => {
    const { businessId } = await business("acct@link.example.test", ["Main"]);
    const accountId = await withAccount(businessId, "acct@link.example.test");
    await ask("acct@link.example.test");
    const [token] = tokensIn(sent[0]);
    const used = await useLink.POST(
      new Request(`${BASE}/inbox/sign-in/${token}`, { method: "POST", headers: { origin: BASE } }),
      ctx(token),
    );
    const cookie = used.headers.get("set-cookie")!.split(";")[0];
    const [sess] = await db
      .select()
      .from(s.ownerSessions)
      .where(eq(s.ownerSessions.loginTokenHash, tokenHash(token)));
    expect(sess.accountId).toBe(accountId);

    sent = [];
    await resetReq.POST(post({ email: "acct@link.example.test" }));
    const resetToken = new RegExp(`${BASE}/account/reset/([\\w-]{43})`).exec(sent[0].text)![1];
    const done = await reset.POST(post({ password: "a brand new long password" }), {
      params: Promise.resolve({ token: resetToken }),
    } as unknown as RouteContext<"/account/reset/[token]">);
    expect(done.status).toBe(303);
    expect((await inbox.GET(new Request(`${BASE}/inbox`, { headers: { cookie } }))).status).toBe(401);
  });

  it("does not tie the session to an account whose email differs from the business's owner email", async () => {
    const { businessId } = await business("owner@link.example.test", ["Main"]);
    await withAccount(businessId, "someone-else@link.example.test");
    await ask("owner@link.example.test");
    const [token] = tokensIn(sent[0]);
    const [sess] = await db
      .select()
      .from(s.ownerSessions)
      .where(eq(s.ownerSessions.loginTokenHash, tokenHash(token)));
    expect(sess.accountId).toBeNull();
    sent = [];
    await ask("someone-else@link.example.test"); // the link goes only to the address on file
    expect(sent).toHaveLength(0);
  });

  it("gives the same answer for a known and an unknown email when the email provider fails", async () => {
    await business("down@link.example.test", ["Main", "Shore"]);
    let attempts = 0;
    vi.spyOn(routeDeps, "make").mockImplementation(() => ({
      email: {
        send: async () => {
          attempts++;
          throw new Error("provider down");
        },
      },
      breach: { isBreached: async () => false },
      baseUrl: BASE,
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unknown = await ask("nobody@link.example.test");
    const known = await ask("down@link.example.test");
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.text()).toBe(await unknown.text());
    expect(attempts).toBe(1);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("down@link.example.test");
  });

  it("creates links and sends after the response, so known and unknown emails answer alike (F-36-2)", async () => {
    const { locations } = await business("later@link.example.test", ["Main"]);
    const tasks: (() => Promise<void>)[] = [];
    const base = routeDeps.make();
    vi.spyOn(routeDeps, "make").mockImplementation(() => ({ ...base, later: (t) => void tasks.push(t) }));
    const known = await ask("later@link.example.test");
    const unknown = await ask("nobody@link.example.test");
    expect(await known.text()).toBe(await unknown.text());
    // Before the response: no link row and no email on either path, and one deferred task each.
    expect(sent).toEqual([]);
    expect(await db.select().from(s.ownerSessions).where(eq(s.ownerSessions.locationId, locations[0].id))).toEqual([]);
    expect(tasks).toHaveLength(2);
    for (const t of tasks) await t();
    expect(sent.map((m) => m.to)).toEqual(["later@link.example.test"]);
  });

  it("rejects a malformed email without sending", async () => {
    const res = await ask("not an email");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Enter a valid email address.");
    expect(sent).toHaveLength(0);
  });

  it("rate-limits per email across IPs and per IP across emails", async () => {
    await business("busy@link.example.test", ["Main"]);
    for (let i = 0; i < LINK_LIMITS.signInLinkEmail.max; i++)
      expect((await ask("busy@link.example.test", { "x-real-ip": `10.2.0.${i}` })).status).toBe(200);
    const limited = await ask("busy@link.example.test", { "x-real-ip": "10.2.1.1" });
    expect(limited.status).toBe(429);
    expect(sent).toHaveLength(LINK_LIMITS.signInLinkEmail.max);

    for (let i = 0; i < LINK_LIMITS.signInLinkIp.max; i++)
      expect((await ask(`n${i}@link.example.test`, { "x-real-ip": "10.3.0.1" })).status).toBe(200);
    expect((await ask("one-more@link.example.test", { "x-real-ip": "10.3.0.1" })).status).toBe(429);
  });

  it("refuses a cross-site post", async () => {
    await business("x@link.example.test", ["Main"]);
    const res = await ask("x@link.example.test", { origin: "https://evil.example.test" });
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
  });
});

// The stored hash of an emailed token (same SHA-256 as src/inbox/auth.ts).
const tokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
