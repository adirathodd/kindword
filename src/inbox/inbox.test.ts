// Runs against the Postgres in DATABASE_URL. Fake data only: example.test emails, made-up reviews.
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import type { EmailMessage, EmailProvider } from "../email/provider";
import {
  LINK_TTL_MS,
  NoOwnerEmailError,
  SESSION_TTL_MS,
  createSignInLink,
  getOwnerSession,
  redeemSignInToken,
  revokeOwnerSessions,
  sendSignInLink,
  signOut,
  type OwnerSession,
} from "./auth";
import { decide, listInbox, OVERDUE_MS } from "./inbox";

const BASE = "https://reviews.example.test";
const NOW = new Date("2026-11-23T15:00:00Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

class FakeEmail implements EmailProvider {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
  }
}

const businessIds: string[] = [];
async function makeTenant(name: string, ownerEmail: string | null = "Owner@Example.test") {
  const [b] = await db.insert(s.businesses).values({ name, vertical: "plumbing", ownerEmail }).returning();
  businessIds.push(b.id);
  const [l] = await db
    .insert(s.locations)
    .values({ businessId: b.id, name: "Main", timezone: "America/New_York", reviewLink: "https://g.page/r/t" })
    .returning();
  return l.id;
}

let n = 0;
async function draft(
  locationId: string,
  opts: {
    status?: (typeof s.draftStatus.enumValues)[number];
    createdAt?: Date;
    rating?: number;
    flags?: string[];
  } = {},
) {
  const [r] = await db
    .insert(s.reviews)
    .values({
      locationId,
      googleReviewId: `g-${locationId}-${n++}`,
      rating: opts.rating ?? 5,
      text: "Fixed our <b>leak</b> fast & clean",
      reviewerName: "Sam",
      flags: opts.flags ?? [],
    })
    .returning();
  const [d] = await db
    .insert(s.replyDrafts)
    .values({
      reviewId: r.id,
      locationId,
      draftText: "Thanks, Sam! We're glad the repair went well.",
      status: opts.status ?? "awaiting_owner",
      model: "test-model",
      promptVersion: 1,
      createdAt: opts.createdAt ?? new Date(NOW.getTime() - HOUR),
    })
    .returning();
  return d.id;
}

const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);
async function signIn(locationId: string, now = NOW): Promise<OwnerSession & { secret: string }> {
  const { url } = await createSignInLink(locationId, { baseUrl: BASE, now });
  const r = await redeemSignInToken(tokenOf(url), { now });
  if (!r) throw new Error("sign-in failed");
  return { ...r.session, secret: r.secret };
}
const draftRow = async (id: string) => (await db.select().from(s.replyDrafts).where(eq(s.replyDrafts.id, id)))[0];
const audit = (entityId: string) => db.select().from(s.auditLog).where(eq(s.auditLog.entityId, entityId));

let A: string;
let B: string;
beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
beforeEach(async () => {
  A = await makeTenant("Alpha Plumbing");
  B = await makeTenant("Beta HVAC");
});
afterEach(async () => {
  await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds.splice(0)));
});
afterAll(() => db.$client.end());

describe("sign-in links", () => {
  it("emails the owner a link and stores only the token's hash", async () => {
    const email = new FakeEmail();
    const { expiresAt } = await sendSignInLink(A, email, { baseUrl: BASE, now: NOW });
    expect(expiresAt).toEqual(new Date(NOW.getTime() + LINK_TTL_MS));
    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m.to).toBe("owner@example.test");
    expect(m.subject).toContain("Alpha Plumbing");
    const url = m.text.match(/https:\/\/\S+/)![0];
    expect(url).toMatch(/^https:\/\/reviews\.example\.test\/inbox\/sign-in\/[A-Za-z0-9_-]{43}$/);
    expect(m.html).toContain(url);

    const [row] = await db.select().from(s.ownerSessions).where(eq(s.ownerSessions.locationId, A));
    expect(row.loginTokenHash).not.toContain(tokenOf(url));
    expect(row.loginTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.sessionExpiresAt).toBeNull();
    const [log] = await audit(row.id);
    expect(log.action).toBe("sign_in_link_created");
    expect(JSON.stringify(log)).not.toContain("example.test");
  });

  it("refuses a business with no owner email", async () => {
    const C = await makeTenant("Gamma Electric", null);
    await expect(createSignInLink(C, { baseUrl: BASE })).rejects.toBeInstanceOf(NoOwnerEmailError);
  });

  it("works once, starting a 30-day session for that location", async () => {
    const { url } = await createSignInLink(A, { baseUrl: BASE, now: NOW });
    const r = await redeemSignInToken(tokenOf(url), { now: new Date(NOW.getTime() + 14 * MIN) });
    expect(r?.session.locationId).toBe(A);
    expect(r?.expiresAt).toEqual(new Date(NOW.getTime() + 14 * MIN + SESSION_TTL_MS));
    expect(r?.secret).not.toBe(tokenOf(url)); // the emailed token is not the session credential
    expect(await redeemSignInToken(tokenOf(url), { now: NOW })).toBeNull();
    expect(await getOwnerSession(tokenOf(url), { now: NOW })).toBeNull();
  });

  it("expires after 15 minutes", async () => {
    const { url } = await createSignInLink(A, { baseUrl: BASE, now: NOW });
    expect(await redeemSignInToken(tokenOf(url), { now: new Date(NOW.getTime() + LINK_TTL_MS) })).toBeNull();
  });

  it("lets only one of two concurrent uses through", async () => {
    const { url } = await createSignInLink(A, { baseUrl: BASE, now: NOW });
    const results = await Promise.all([1, 2, 3].map(() => redeemSignInToken(tokenOf(url), { now: NOW })));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("rejects malformed and unknown tokens", async () => {
    for (const t of ["", "short", "x".repeat(43), "../../etc/passwd", "a".repeat(44)])
      expect(await redeemSignInToken(t, { now: NOW })).toBeNull();
  });
});

describe("sessions", () => {
  it("last 30 days", async () => {
    const sess = await signIn(A);
    expect(await getOwnerSession(sess.secret, { now: new Date(NOW.getTime() + SESSION_TTL_MS - 1) })).toEqual({
      sessionId: sess.sessionId,
      locationId: A,
    });
    expect(await getOwnerSession(sess.secret, { now: new Date(NOW.getTime() + SESSION_TTL_MS) })).toBeNull();
  });

  it("end on sign-out", async () => {
    const sess = await signIn(A);
    await signOut(sess.secret);
    expect(await getOwnerSession(sess.secret, { now: NOW })).toBeNull();
    expect((await audit(sess.sessionId)).map((r) => r.action)).toContain("signed_out");
  });

  it("can be revoked by the operator, with unused links, for one location only", async () => {
    const a = await signIn(A);
    const { url: unused } = await createSignInLink(A, { baseUrl: BASE, now: NOW });
    const b = await signIn(B);
    expect(await revokeOwnerSessions(A, { now: NOW })).toBe(2);
    expect(await getOwnerSession(a.secret, { now: NOW })).toBeNull();
    expect(await redeemSignInToken(tokenOf(unused), { now: NOW })).toBeNull();
    expect(await getOwnerSession(b.secret, { now: NOW })).not.toBeNull();
  });
});

describe("listInbox", () => {
  it("lists pending drafts oldest first, approved ones, and replies posted in the last 30 days, for its location only", async () => {
    const sess = await signIn(A);
    const old = await draft(A, { createdAt: new Date(NOW.getTime() - OVERDUE_MS - MIN) });
    const held = await draft(A, { status: "held", rating: 1, flags: ["low_rating"] });
    await draft(A, { status: "rejected" });
    await draft(A, { status: "draft" }); // not ready for the owner yet
    await draft(B); // another business

    const approved = await draft(A);
    await decide(sess, approved, { action: "approve" }, { now: NOW });
    const recent = await draft(A);
    const stale = await draft(A);
    await decide(sess, recent, { action: "approve" }, { now: NOW });
    await decide(sess, stale, { action: "approve" }, { now: NOW });
    await db
      .update(s.replyDrafts)
      .set({ status: "posted", postedAt: new Date(NOW.getTime() - 29 * DAY) })
      .where(eq(s.replyDrafts.id, recent));
    await db
      .update(s.replyDrafts)
      .set({ status: "posted", postedAt: new Date(NOW.getTime() - 31 * DAY) })
      .where(eq(s.replyDrafts.id, stale));

    const inbox = await listInbox(sess, { now: NOW });
    expect(inbox.pending.map((i) => [i.draftId, i.overdue])).toEqual([
      [old, true],
      [held, false],
    ]);
    expect(inbox.pending[1]).toMatchObject({ status: "held", rating: 1, flags: ["low_rating"] });
    expect(inbox.approved.map((i) => i.draftId)).toEqual([approved]);
    expect(inbox.posted.map((i) => i.draftId)).toEqual([recent]);
  });
});

describe("decide", () => {
  let sess: OwnerSession;
  beforeEach(async () => {
    sess = await signIn(A);
  });

  it("approves a draft as written and audits edited=no and minutes to approve", async () => {
    const id = await draft(A, { createdAt: new Date(NOW.getTime() - 95 * MIN) });
    expect(await decide(sess, id, { action: "approve" }, { now: NOW })).toEqual({
      ok: true,
      status: "approved",
      edited: false,
    });
    const d = await draftRow(id);
    expect(d).toMatchObject({ status: "approved", approvedSessionId: sess.sessionId, approvedAt: NOW });
    expect(d.finalText).toBe(d.draftText);
    expect(d.postedAt).toBeNull(); // approval never posts by itself
    const [log] = await audit(id);
    expect(log).toMatchObject({
      action: "approved",
      actor: `owner_session:${sess.sessionId}`,
      detail: "edited=no;minutes=95;flagged=no",
    });
  });

  it("saves the owner's edit as the reply and audits edited=yes without the text", async () => {
    const id = await draft(A);
    const r = await decide(
      sess,
      id,
      { action: "edit", text: "  Thank you, Sam!\r\nSee you next time.  " },
      { now: NOW },
    );
    expect(r).toEqual({ ok: true, status: "approved", edited: true });
    expect((await draftRow(id)).finalText).toBe("Thank you, Sam!\nSee you next time.");
    const [log] = await audit(id);
    expect(log.detail).toBe("edited=yes;minutes=60;flagged=no");
    expect(JSON.stringify(log)).not.toContain("Sam");
  });

  it("counts an unchanged edit as not edited", async () => {
    const id = await draft(A);
    const r = await decide(sess, id, { action: "edit", text: "Thanks, Sam! We're glad the repair went well." });
    expect(r).toMatchObject({ ok: true, edited: false });
  });

  it("rejects empty or over-long edits", async () => {
    const id = await draft(A);
    expect(await decide(sess, id, { action: "edit", text: " \n " })).toEqual({ ok: false, reason: "empty_text" });
    expect(await decide(sess, id, { action: "edit", text: "x".repeat(4001) })).toEqual({
      ok: false,
      reason: "too_long",
    });
    expect((await draftRow(id)).status).toBe("awaiting_owner");
  });

  it("rejects a draft so it is never posted", async () => {
    const id = await draft(A);
    expect(await decide(sess, id, { action: "reject" }, { now: NOW })).toEqual({
      ok: true,
      status: "rejected",
      edited: false,
    });
    const d = await draftRow(id);
    expect(d).toMatchObject({ status: "rejected", approvedAt: null, finalText: null });
    expect((await audit(id))[0]).toMatchObject({ action: "rejected", detail: "minutes=60;flagged=no" });
  });

  it("gives a held (flagged) draft no one-tap approve: it needs a confirmed Approve anyway or an edit", async () => {
    const id = await draft(A, { status: "held", rating: 2, flags: ["low_rating"] });
    expect(await decide(sess, id, { action: "approve" })).toEqual({ ok: false, reason: "not_allowed" });
    expect(await decide(sess, id, { action: "approve_anyway", confirmed: false })).toEqual({
      ok: false,
      reason: "needs_confirmation",
    });
    expect((await draftRow(id)).status).toBe("held");
    expect(await decide(sess, id, { action: "approve_anyway", confirmed: true }, { now: NOW })).toMatchObject({
      ok: true,
      status: "approved",
    });
    expect((await audit(id))[0].detail).toBe("edited=no;minutes=60;flagged=yes");

    const id2 = await draft(A, { status: "held", flags: ["legal"] });
    expect(await decide(sess, id2, { action: "edit", text: "Please call us." })).toMatchObject({ ok: true });
  });

  it("does not offer Approve anyway for an unflagged draft", async () => {
    const id = await draft(A);
    expect(await decide(sess, id, { action: "approve_anyway", confirmed: true })).toEqual({
      ok: false,
      reason: "not_allowed",
    });
  });

  it("decides a draft only once, even with concurrent submits", async () => {
    const id = await draft(A);
    const results = await Promise.all([
      decide(sess, id, { action: "approve" }),
      decide(sess, id, { action: "reject" }),
      decide(sess, id, { action: "edit", text: "Other" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await audit(id)).toHaveLength(1);
    expect(await decide(sess, id, { action: "reject" })).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("never lets a session touch another location's draft", async () => {
    const theirs = await draft(B);
    for (const decision of [{ action: "approve" }, { action: "reject" }, { action: "edit", text: "hi" }] as const)
      expect(await decide(sess, theirs, decision)).toEqual({ ok: false, reason: "not_found" });
    expect((await draftRow(theirs)).status).toBe("awaiting_owner");
    expect(await audit(theirs)).toEqual([]);
  });

  it("treats a malformed draft ID as not found", async () => {
    expect(await decide(sess, "not-a-uuid", { action: "approve" })).toEqual({ ok: false, reason: "not_found" });
  });

  it("cannot approve already posted, rejected or not-yet-ready drafts", async () => {
    for (const status of ["posted", "rejected", "draft", "failed", "approved"] as const) {
      const id = await draft(A, { status: status === "posted" ? "awaiting_owner" : status });
      if (status === "posted") {
        await decide(sess, id, { action: "approve" });
        await db.update(s.replyDrafts).set({ status: "posted", postedAt: NOW }).where(eq(s.replyDrafts.id, id));
      }
      expect(await decide(sess, id, { action: "approve" })).toEqual({ ok: false, reason: "not_allowed" });
    }
  });
});
