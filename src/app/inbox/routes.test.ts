// End-to-end tests of the owner inbox routes against the Postgres in DATABASE_URL: sign-in link, session cookie,
// inbox page, decisions and sign-out, through the real route handlers. Fake data only.
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db/client";
import * as s from "../../db/schema";
import { createSignInLink } from "../../inbox/auth";
import * as decision from "./drafts/[id]/route";
import * as inbox from "./route";
import * as signIn from "./sign-in/[token]/route";
import * as signOut from "./sign-out/route";

const BASE = "https://reviews.example.test";
const ctx = <K extends string>(key: K, value: string) =>
  ({ params: Promise.resolve({ [key]: value }) }) as unknown as RouteContext<never>;
const form = (fields: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, ...headers },
  body: new URLSearchParams(fields),
});

const businessIds: string[] = [];
async function makeTenant(name: string) {
  const [b] = await db
    .insert(s.businesses)
    .values({ name, vertical: "plumbing", ownerEmail: "owner@example.test" })
    .returning();
  businessIds.push(b.id);
  const [l] = await db
    .insert(s.locations)
    .values({ businessId: b.id, name: "Main", timezone: "America/New_York", reviewLink: "https://g.page/r/t" })
    .returning();
  return l.id;
}
let n = 0;
async function draft(locationId: string, status: "awaiting_owner" | "held" = "awaiting_owner", text = "Great work") {
  const [r] = await db
    .insert(s.reviews)
    .values({
      locationId,
      googleReviewId: `rt-${n++}`,
      rating: status === "held" ? 1 : 5,
      text,
      reviewerName: "Sam",
      flags: status === "held" ? ["low_rating", "legal"] : [],
    })
    .returning();
  const [d] = await db
    .insert(s.replyDrafts)
    .values({ reviewId: r.id, locationId, draftText: `Thanks for "${text}"`, status, model: "m", promptVersion: 1 })
    .returning();
  return d.id;
}

// Walks the real sign-in flow and returns the Cookie header value.
async function cookieFor(locationId: string) {
  const { url } = await createSignInLink(locationId, { baseUrl: BASE });
  const token = url.slice(url.lastIndexOf("/") + 1);
  const res = await signIn.POST(new Request(url, form({})), ctx("token", token));
  return res.headers.get("set-cookie")!.split(";")[0];
}
const getInbox = (cookie?: string, q = "") =>
  inbox.GET(new Request(`${BASE}/inbox${q}`, { headers: cookie ? { cookie } : {} }));
const act = (cookie: string, id: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  decision.POST(new Request(`${BASE}/inbox/drafts/${id}`, form(fields, { cookie, ...headers })), ctx("id", id));
const status = async (id: string) =>
  (await db.select({ s: s.replyDrafts.status }).from(s.replyDrafts).where(eq(s.replyDrafts.id, id)))[0].s;

let A: string;
let B: string;
beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
beforeEach(async () => {
  vi.stubEnv("APP_BASE_URL", BASE);
  A = await makeTenant("Alpha Plumbing");
  B = await makeTenant("Beta HVAC");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds.splice(0)));
});
afterAll(() => db.$client.end());

describe("sign-in link routes", () => {
  it("GET only shows a button, so a link scanner cannot use the token up", async () => {
    const { url } = await createSignInLink(A, { baseUrl: BASE });
    const token = url.slice(url.lastIndexOf("/") + 1);
    const page = await signIn.GET(new Request(url), ctx("token", token));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<form method="post">');
    const [row] = await db.select().from(s.ownerSessions).where(eq(s.ownerSessions.locationId, A));
    expect(row.sessionTokenHash).toBeNull();
  });

  it("POST sets a 30-day HttpOnly, Secure, SameSite cookie scoped to /inbox and redirects to the inbox", async () => {
    const { url } = await createSignInLink(A, { baseUrl: BASE });
    const token = url.slice(url.lastIndexOf("/") + 1);
    const res = await signIn.POST(new Request(url, form({})), ctx("token", token));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/inbox");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(
      /^owner_session=[A-Za-z0-9_-]{43}; Path=\/inbox; Expires=.+; HttpOnly; SameSite=Lax; Secure$/,
    );
    expect(cookie).not.toContain(token);
    const expires = new Date(cookie.match(/Expires=([^;]+)/)![1]).getTime();
    expect(Math.abs(expires - (Date.now() + 30 * 24 * 3600 * 1000))).toBeLessThan(5000);

    const again = await signIn.POST(new Request(url, form({})), ctx("token", token));
    expect(again.status).toBe(400); // single use
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a cross-site sign-in post", async () => {
    const { url } = await createSignInLink(A, { baseUrl: BASE });
    const token = url.slice(url.lastIndexOf("/") + 1);
    const res = await signIn.POST(
      new Request(url, form({}, { origin: "https://evil.example.test" })),
      ctx("token", token),
    );
    expect(res.status).toBe(403);
  });
});

describe("inbox page", () => {
  it("asks to sign in without a valid session", async () => {
    expect((await getInbox()).status).toBe(401);
    expect((await getInbox("owner_session=" + "a".repeat(43))).status).toBe(401);
  });

  it("shows only the session's location, escapes review text, and sets protective headers", async () => {
    await draft(A, "awaiting_owner", "<script>alert(1)</script> fixed fast");
    await draft(B, "awaiting_owner", "Beta only review");
    const res = await getInbox(await cookieFor(A));
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Waiting for you (1)");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt; fixed fast");
    expect(page).not.toContain("<script>");
    expect(page).not.toContain("Beta only review");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Not no-referrer: that makes browsers send "Origin: null" on our own form posts, which sameOrigin refuses.
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("gives a held draft its flags and Approve anyway with a required confirmation, and no one-tap Approve", async () => {
    const id = await draft(A, "held", "They broke my pipe, calling my lawyer");
    const page = await (await getInbox(await cookieFor(A))).text();
    const card = page.slice(page.indexOf(`id="d-${id}"`));
    expect(card).toContain("Needs extra care");
    expect(card).toContain("Rating of 2 stars or lower");
    expect(card).toContain("Mentions legal action");
    expect(card).toContain('name="confirm" value="yes" required');
    expect(card).toContain('value="approve_anyway"');
    expect(card).not.toContain('value="approve"');
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "renders the inbox when ?done= names an inherited object key (%s)",
    async (key) => {
      const res = await getInbox(await cookieFor(A), `?done=${key}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Waiting for you");
    },
  );

  // F-40-1: owner emails link to /inbox?location=<id>; a session for another location must not pass as that inbox.
  it("shows the inbox when ?location= is the session's location", async () => {
    await draft(A, "awaiting_owner", "Alpha review");
    const res = await getInbox(await cookieFor(A), `?location=${A}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Alpha review");
  });

  it("does not show another location's inbox for ?location= of a location the session does not cover", async () => {
    await draft(A, "awaiting_owner", "Alpha review");
    await draft(B, "awaiting_owner", "Beta only review");
    const res = await getInbox(await cookieFor(A), `?location=${B}`);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).not.toContain("Alpha review");
    expect(page).not.toContain("Beta only review");
    expect(page).not.toContain("Beta HVAC");
    expect(page).toContain(`<form method="post" action="/account/inbox/${B}">`);
    expect(page).toContain('href="/inbox"');
    expect(page).toContain('href="/account/sign-in"');
  });

  it("asks to sign in for ?location= without a session, and ignores a malformed ?location=", async () => {
    expect((await getInbox(undefined, `?location=${B}`)).status).toBe(401);
    await draft(A, "awaiting_owner", "Alpha review");
    const page = await (await getInbox(await cookieFor(A), `?location=%22%3E%3Cscript%3E`)).text();
    expect(page).toContain("Alpha review");
    expect(page).not.toContain("<script>");
  });

  it("shows an empty state", async () => {
    const page = await (await getInbox(await cookieFor(A))).text();
    expect(page).toContain("No replies waiting for you");
    expect(page).toContain("No replies posted in the last 30 days");
  });
});

describe("draft decisions", () => {
  it("approves, then shows the reply under approved with a notice", async () => {
    const cookie = await cookieFor(A);
    const id = await draft(A);
    const res = await act(cookie, id, { action: "approve" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/inbox?done=approved");
    expect(await status(id)).toBe("approved");
    const page = await (await getInbox(cookie, "?done=approved")).text();
    expect(page).toContain("Reply approved.");
    expect(page).toContain("Approved, waiting to post (1)");
    expect(page).toContain("Waiting for you (0)");
  });

  it("edits and approves, and rejects", async () => {
    const cookie = await cookieFor(A);
    const e = await draft(A);
    await act(cookie, e, { action: "edit", text: "Thank you!" });
    const [row] = await db.select().from(s.replyDrafts).where(eq(s.replyDrafts.id, e));
    expect(row).toMatchObject({ status: "approved", finalText: "Thank you!" });

    const r = await draft(A);
    expect((await act(cookie, r, { action: "reject" })).headers.get("location")).toBe("/inbox?done=rejected");
    expect(await status(r)).toBe("rejected");
  });

  it("needs the confirmation box for Approve anyway", async () => {
    const cookie = await cookieFor(A);
    const id = await draft(A, "held");
    const res = await act(cookie, id, { action: "approve_anyway" });
    expect(res.headers.get("location")).toBe("/inbox?done=needs_confirmation");
    expect(await status(id)).toBe("held");
    await act(cookie, id, { action: "approve_anyway", confirm: "yes" });
    expect(await status(id)).toBe("approved");
  });

  it("does not approve a held draft when its pre-filled edit form is saved unchanged", async () => {
    const cookie = await cookieFor(A);
    const id = await draft(A, "held", "They broke my pipe, calling my lawyer");
    const page = await (await getInbox(cookie)).text();
    const card = page.slice(page.indexOf(`id="d-${id}"`), page.indexOf("</article>", page.indexOf(`id="d-${id}"`)));
    const prefilled = card
      .match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)![1]
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    const res = await act(cookie, id, { action: "edit", text: prefilled });
    expect(res.headers.get("location")).toBe("/inbox?done=needs_confirmation");
    expect(await status(id)).toBe("held");
  });

  it("cannot act on another location's draft", async () => {
    const theirs = await draft(B);
    const res = await act(await cookieFor(A), theirs, { action: "approve" });
    expect(res.headers.get("location")).toBe("/inbox?done=not_found");
    expect(await status(theirs)).toBe("awaiting_owner");
  });

  it("refuses cross-site posts and posts without a session", async () => {
    const cookie = await cookieFor(A);
    const id = await draft(A);
    expect((await act(cookie, id, { action: "approve" }, { origin: "https://evil.example.test" })).status).toBe(403);
    expect((await act(cookie, id, { action: "approve" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await act(cookie, id, { action: "approve" }, { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await act(cookie, id, { action: "approve" }, { origin: "null" })).status).toBe(403);
    expect((await act("owner_session=nope", id, { action: "approve" })).status).toBe(401);
    expect((await act(cookie, id, { action: "launch" })).status).toBe(400);
    expect(await status(id)).toBe("awaiting_owner");
  });
});

describe("sign-out", () => {
  it("ends the session and clears the cookie", async () => {
    const cookie = await cookieFor(A);
    const res = await signOut.POST(new Request(`${BASE}/inbox/sign-out`, form({}, { cookie })));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("owner_session=; Path=/inbox; Expires=Thu, 01 Jan 1970");
    expect((await getInbox(cookie)).status).toBe(401);
  });
});
