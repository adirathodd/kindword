// Runs against the Postgres in DATABASE_URL. Fake data only: 555-01xx numbers, example.test emails. No live sends.
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GET as clickGET, HEAD as clickHEAD } from "../app/r/[id]/route";
import { GET as unsubGET, POST as unsubPOST } from "../app/u/[token]/route";
import { db } from "../db/client";
import * as s from "../db/schema";
import type { EmailMessage, EmailProvider } from "../email/provider";
import type { InboundSms, SmsProvider } from "../sms/provider";
import {
  recordClick,
  runReviewRequestJobs,
  scheduleReminders,
  scheduleReviewRequests,
  sendConfigFromEnv,
  sendDueRequests,
  type RequestJobOptions,
} from "./requests";

process.env.UNSUBSCRIBE_SECRET ??= "test-only-secret-0123456789abcdef0123";

const PHONE = "+12015550110";
const EMAIL = "pat@example.test";
const NUMBER = "+12015550180";
const BASE = "https://app.example.test";
const config = { baseUrl: BASE, postalAddress: "PO Box 1, Hoboken, NJ 07030" };
const HOUR = 3600_000;
const DAY = 24 * HOUR;

// 10:00 a.m. New York time (EST) on a Monday; requests are due at noon.
const VISIT = new Date("2026-11-23T15:00:00Z");
const DUE = new Date("2026-11-23T17:00:00Z");
const plus = (t: Date, ms: number) => new Date(t.getTime() + ms);

class FakeSms implements SmsProvider {
  sent: { from: string; to: string; body: string }[] = [];
  fail = false;
  async parseInbound(): Promise<InboundSms | null> {
    return null;
  }
  async send(from: string, to: string, body: string) {
    if (this.fail) throw new Error(`Twilio 21211 invalid 'To' ${to}`); // provider errors can echo the number
    this.sent.push({ from, to, body });
    return `SM${this.sent.length}`;
  }
}
class FakeEmail implements EmailProvider {
  sent: EmailMessage[] = [];
  fail = false;
  async send(m: EmailMessage) {
    if (this.fail) throw new Error("resend 422");
    this.sent.push(m);
    return `em_${this.sent.length}`;
  }
}

let sms: FakeSms;
let email: FakeEmail;
const providers = () => ({ sms, email });
const send = (now: Date, o: RequestJobOptions = {}) => sendDueRequests(providers(), { now, config, ...o });

const businessIds: string[] = [];
async function makeTenant({
  smsNumber = NUMBER as string | null,
  status = "live" as "live" | "onboarding" | "paused" | "offboarded",
} = {}) {
  sms = new FakeSms();
  email = new FakeEmail();
  const [b] = await db.insert(s.businesses).values({ name: "Acme Plumbing", vertical: "plumbing", status }).returning();
  businessIds.push(b.id);
  const [l] = await db
    .insert(s.locations)
    .values({
      businessId: b.id,
      name: "Main",
      timezone: "America/New_York",
      reviewLink: "https://g.page/r/acme/review",
      smsNumber,
    })
    .returning();
  const [a] = await db
    .insert(s.consentAttestations)
    .values({ businessId: b.id, signedAt: new Date(), documentRef: "attest.pdf", listDescription: "signed estimates" })
    .returning();
  const customer = async ({
    phone = PHONE as string | null,
    mail = EMAIL as string | null,
    language = null as string | null,
  } = {}) => {
    const [c] = await db
      .insert(s.customers)
      .values({
        locationId: l.id,
        businessId: b.id,
        language,
        phone,
        normalizedPhone: phone,
        email: mail,
        normalizedEmail: mail,
        ...(phone && {
          consentMethod: "signed_estimate" as const,
          consentWordingVersion: "v1",
          consentAt: new Date("2026-11-01T15:00:00Z"),
          consentEvidenceRef: "estimate-0001.pdf",
          attestationId: a.id,
        }),
      })
      .returning();
    return c.id;
  };
  let n = 0;
  const visit = async (customerId: string, visitAt: Date = VISIT) => {
    const [v] = await db
      .insert(s.visits)
      .values({ customerId, locationId: l.id, visitAt, source: "csv", externalVisitId: `v-${++n}` })
      .returning();
    return v.id;
  };
  return { businessId: b.id, locationId: l.id, customer, visit };
}

const requestsOf = (visitId: string) =>
  db.select().from(s.reviewRequests).where(eq(s.reviewRequests.visitId, visitId)).orderBy(s.reviewRequests.attempt);
const one = async (visitId: string) => {
  const rows = await requestsOf(visitId);
  expect(rows).toHaveLength(1);
  return rows[0];
};

beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
afterEach(async () => {
  // Jobs scan every location, so each test removes its tenant to keep later counts exact.
  if (businessIds.length) await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds.splice(0)));
});
afterAll(() => db.$client.end());

describe("scheduling (FR-5)", () => {
  it("schedules an SMS 2 hours after the visit and sends it when due", async () => {
    const t = await makeTenant();
    const v = await t.visit(await t.customer());
    expect(await scheduleReviewRequests({ now: VISIT })).toEqual({ scheduled: 1, skipped: {} });
    const rr = await one(v);
    expect(rr).toMatchObject({ channel: "sms", attempt: 1, status: "scheduled", scheduledFor: DUE });

    expect(await send(plus(DUE, -60_000))).toMatchObject({ sent: 0 }); // not yet due
    expect(await send(DUE)).toMatchObject({ sent: 1, failed: 0 });
    expect(sms.sent).toEqual([{ from: NUMBER, to: PHONE, body: expect.stringContaining(`${BASE}/r/${rr.id}`) }]);
    expect(sms.sent[0].body).toMatch(/^Acme Plumbing: .*Reply STOP to opt out\.$/);
    expect(await one(v)).toMatchObject({ status: "sent", sentAt: DUE, providerMessageId: "SM1" });
  });

  it("moves a request that would land after 8 p.m. to 9 a.m. the next day", async () => {
    const t = await makeTenant();
    const v = await t.visit(await t.customer(), new Date("2026-11-24T00:30:00Z")); // 7:30 p.m. EST
    await scheduleReviewRequests({ now: VISIT });
    expect((await one(v)).scheduledFor).toEqual(new Date("2026-11-24T14:00:00Z"));
  });

  it("uses a configured delay", async () => {
    const t = await makeTenant();
    const v = await t.visit(await t.customer());
    await scheduleReviewRequests({ now: VISIT, delayMs: 4 * HOUR });
    expect((await one(v)).scheduledFor).toEqual(plus(VISIT, 4 * HOUR));
  });

  it("schedules a visit imported late for now, not in the past", async () => {
    const t = await makeTenant();
    const v = await t.visit(await t.customer());
    const now = plus(VISIT, 5 * HOUR);
    await scheduleReviewRequests({ now });
    expect((await one(v)).scheduledFor).toEqual(now);
  });

  it("skips a visit that cannot be asked within 72 hours as stale", async () => {
    const t = await makeTenant();
    const v = await t.visit(await t.customer(), plus(VISIT, -4 * DAY));
    expect(await scheduleReviewRequests({ now: VISIT })).toEqual({ scheduled: 0, skipped: { stale: 1 } });
    expect(await one(v)).toMatchObject({ status: "skipped", skipReason: "stale" });
  });

  it("creates exactly one request per visit however often it runs", async () => {
    const t = await makeTenant();
    const v = await t.visit(await t.customer());
    await Promise.all([scheduleReviewRequests({ now: VISIT }), scheduleReviewRequests({ now: VISIT })]);
    await scheduleReviewRequests({ now: VISIT });
    await one(v);
  });

  it("asks every customer whatever the visit (no filtering, FR-10)", async () => {
    const t = await makeTenant();
    const visits = [
      await t.visit(await t.customer()),
      await t.visit(await t.customer({ phone: "+12015550111", mail: null })),
      await t.visit(await t.customer({ phone: null, mail: "sam@example.test" })),
    ];
    expect((await scheduleReviewRequests({ now: VISIT })).scheduled).toBe(3);
    for (const v of visits) expect((await one(v)).status).toBe("scheduled");
  });
});

describe("channel (FR-6)", () => {
  it("emails a customer with no phone, with a working unsubscribe link and postal address", async () => {
    const t = await makeTenant();
    const v = await t.visit(await t.customer({ phone: null }));
    await scheduleReviewRequests({ now: VISIT });
    expect((await one(v)).channel).toBe("email");
    await send(DUE);
    expect(sms.sent).toEqual([]);
    expect(email.sent).toHaveLength(1);
    const m = email.sent[0];
    expect(m).toMatchObject({ to: EMAIL, fromName: "Acme Plumbing" });
    expect(m.text).toContain(`${BASE}/r/${(await one(v)).id}`);
    expect(m.text).toContain(config.postalAddress);
    expect((await one(v)).providerMessageId).toBe("em_1");
    expect(m.idempotencyKey).toBe(`review-request/${(await one(v)).id}`);

    const token = /\/u\/([A-Za-z0-9_-]+)/.exec(m.text)![1];
    const res = await unsubPOST(new Request(`${BASE}/u/${token}`, { method: "POST" }), ctx({ token }));
    expect(res.status).toBe(200);
    const sup = await db
      .select()
      .from(s.suppressionList)
      .where(and(eq(s.suppressionList.channel, "email"), eq(s.suppressionList.address, EMAIL)));
    expect(sup.map((r) => r.locationId).sort()).toEqual([t.locationId, null].sort());
    await db.delete(s.suppressionList).where(eq(s.suppressionList.address, EMAIL));
  });

  it("emails a customer with phone and email while the location has no texting number (10DLC pending)", async () => {
    const t = await makeTenant({ smsNumber: null });
    const v = await t.visit(await t.customer());
    await scheduleReviewRequests({ now: VISIT });
    expect((await one(v)).channel).toBe("email");
  });

  it("holds a phone-only request until the location can text, then lets it go stale", async () => {
    const t = await makeTenant({ smsNumber: null });
    const v = await t.visit(await t.customer({ mail: null }));
    await scheduleReviewRequests({ now: VISIT });
    expect(await send(DUE)).toMatchObject({ waiting: 1, sent: 0 });
    expect((await one(v)).status).toBe("scheduled");
    expect(await send(plus(VISIT, 73 * HOUR))).toMatchObject({ skipped: { stale: 1 } });
    expect(await one(v)).toMatchObject({ status: "skipped", skipReason: "stale" });
  });

  it("falls back to email when the text fails, and never sends on both channels", async () => {
    const t = await makeTenant();
    const v = await t.visit(await t.customer());
    await scheduleReviewRequests({ now: VISIT });
    sms.fail = true;
    expect(await send(DUE)).toMatchObject({ sent: 0, failed: 1 });
    const [failed, fallback] = await requestsOf(v).then((r) => r.sort((a) => (a.channel === "sms" ? -1 : 1)));
    expect(failed).toMatchObject({ channel: "sms", status: "failed", sentAt: null });
    expect(fallback).toMatchObject({ channel: "email", attempt: 1, status: "scheduled" });

    expect(await send(plus(DUE, 60_000))).toMatchObject({ sent: 1 });
    expect(sms.sent).toEqual([]);
    expect(email.sent).toHaveLength(1);
    expect(await send(plus(DUE, 120_000))).toMatchObject({ sent: 0, failed: 0 });
  });

  it("marks a failed text with no email as failed, with nothing else sent", async () => {
    const t = await makeTenant();
    const v = await t.visit(await t.customer({ mail: null }));
    await scheduleReviewRequests({ now: VISIT });
    sms.fail = true;
    await send(DUE);
    expect(await one(v)).toMatchObject({ status: "failed" });
  });

  it("writes Spanish when the customer's language is Spanish", async () => {
    const t = await makeTenant();
    await t.visit(await t.customer({ language: "es" }));
    await scheduleReviewRequests({ now: VISIT });
    await send(DUE);
    expect(sms.sent[0].body).toMatch(/reseña en Google/);
    expect(sms.sent[0].body).toMatch(/Reply STOP to opt out\.$/);
  });
});

describe("send-time checks", () => {
  it("re-checks suppression at send time (FR-5, FR-8)", async () => {
    const t = await makeTenant();
    const v = await t.visit(await t.customer());
    await scheduleReviewRequests({ now: VISIT });
    await db.insert(s.suppressionList).values({ locationId: null, channel: "sms", address: PHONE, source: "test" });
    try {
      expect(await send(DUE)).toMatchObject({ sent: 0, skipped: { opted_out: 1 } });
      expect(await one(v)).toMatchObject({ status: "skipped", skipReason: "opted_out" });
      expect(sms.sent).toEqual([]);
    } finally {
      await db.delete(s.suppressionList).where(eq(s.suppressionList.address, PHONE));
    }
  });

  it("skips an opted-out customer at scheduling, even when only their other address was suppressed", async () => {
    const t = await makeTenant();
    const v = await t.visit(await t.customer());
    await db
      .insert(s.suppressionList)
      .values({ locationId: t.locationId, channel: "email", address: EMAIL, source: "test" });
    expect(await scheduleReviewRequests({ now: VISIT })).toEqual({ scheduled: 0, skipped: { opted_out: 1 } });
    expect((await one(v)).skipReason).toBe("opted_out");
  });

  it("skips a customer flagged opted out", async () => {
    const t = await makeTenant();
    const c = await t.customer();
    await db.update(s.customers).set({ optedOutAt: new Date() }).where(eq(s.customers.id, c));
    await t.visit(c);
    expect((await scheduleReviewRequests({ now: VISIT })).skipped).toEqual({ opted_out: 1 });
  });

  it("sends nothing for a business that is not live", async () => {
    for (const [i, status] of (["onboarding", "paused", "offboarded"] as const).entries()) {
      const t = await makeTenant({ status, smsNumber: `+1201555019${i}` });
      const v = await t.visit(await t.customer());
      await scheduleReviewRequests({ now: VISIT });
      expect(await send(DUE)).toMatchObject({ sent: 0, waiting: 1 });
      expect((await one(v)).status).toBe("scheduled");
      expect(sms.sent).toEqual([]);
      await db.delete(s.businesses).where(eq(s.businesses.id, t.businessId)); // keep the next iteration's counts exact
    }
  });

  it("defers a request picked up after 8 p.m. to 9 a.m. the next day", async () => {
    const t = await makeTenant();
    const v = await t.visit(await t.customer());
    await scheduleReviewRequests({ now: VISIT });
    const late = new Date("2026-11-24T01:30:00Z"); // 8:30 p.m. EST
    expect(await send(late)).toMatchObject({ sent: 0, deferred: 1 });
    expect(await one(v)).toMatchObject({ status: "scheduled", scheduledFor: new Date("2026-11-24T14:00:00Z") });
    expect(await send(new Date("2026-11-24T14:00:00Z"))).toMatchObject({ sent: 1 });
  });

  it("skips a request that cannot go out within 72 hours of the visit", async () => {
    const t = await makeTenant();
    const v = await t.visit(await t.customer());
    await scheduleReviewRequests({ now: VISIT });
    expect(await send(plus(VISIT, 72 * HOUR + 60_000))).toMatchObject({ skipped: { stale: 1 } });
    expect(await one(v)).toMatchObject({ skipReason: "stale" });
  });

  it("never sends one request twice, even with concurrent runs", async () => {
    const t = await makeTenant();
    await t.visit(await t.customer());
    await scheduleReviewRequests({ now: VISIT });
    const results = await Promise.all([send(DUE), send(DUE), send(DUE)]);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1);
    await send(plus(DUE, HOUR));
    expect(sms.sent).toHaveLength(1);
  });

  it("refuses to run without its settings and claims nothing", async () => {
    expect(() => sendConfigFromEnv({ MAIL_POSTAL_ADDRESS: "x", UNSUBSCRIBE_SECRET: "x".repeat(32) })).toThrow(
      /APP_BASE_URL/,
    );
    expect(() =>
      sendConfigFromEnv({ APP_BASE_URL: "ftp://x", MAIL_POSTAL_ADDRESS: "x", UNSUBSCRIBE_SECRET: "x".repeat(32) }),
    ).toThrow(/APP_BASE_URL/);
    expect(() => sendConfigFromEnv({ APP_BASE_URL: BASE, UNSUBSCRIBE_SECRET: "x".repeat(32) })).toThrow(
      /MAIL_POSTAL_ADDRESS/,
    );
    expect(() =>
      sendConfigFromEnv({ APP_BASE_URL: BASE, MAIL_POSTAL_ADDRESS: "x", UNSUBSCRIBE_SECRET: "short" }),
    ).toThrow(/UNSUBSCRIBE_SECRET/);
    expect(
      sendConfigFromEnv({
        APP_BASE_URL: `${BASE}/`,
        MAIL_POSTAL_ADDRESS: " PO Box 1 ",
        UNSUBSCRIBE_SECRET: "x".repeat(32),
      }),
    ).toEqual({
      baseUrl: BASE,
      postalAddress: "PO Box 1",
    });

    const t = await makeTenant();
    const v = await t.visit(await t.customer());
    await scheduleReviewRequests({ now: VISIT });
    const saved = process.env.APP_BASE_URL;
    delete process.env.APP_BASE_URL;
    try {
      await expect(sendDueRequests(providers(), { now: DUE })).rejects.toThrow(/APP_BASE_URL/);
    } finally {
      if (saved !== undefined) process.env.APP_BASE_URL = saved;
    }
    expect((await one(v)).status).toBe("scheduled");
  });
});

describe("90-day rule (FR-9)", () => {
  it("does not ask the same customer again within 90 days at a location", async () => {
    const t = await makeTenant();
    const c = await t.customer();
    const first = await t.visit(c);
    await scheduleReviewRequests({ now: VISIT });
    await send(DUE);
    const second = await t.visit(c, plus(VISIT, 30 * DAY));
    expect(await scheduleReviewRequests({ now: plus(VISIT, 30 * DAY) })).toEqual({
      scheduled: 0,
      skipped: { duplicate: 1 },
    });
    expect((await one(second)).skipReason).toBe("duplicate");
    expect((await one(first)).status).toBe("sent");
  });

  it("asks again after 90 days", async () => {
    const t = await makeTenant();
    const c = await t.customer();
    await t.visit(c);
    await scheduleReviewRequests({ now: VISIT });
    await send(DUE);
    const later = plus(VISIT, 91 * DAY);
    const v = await t.visit(c, later);
    await scheduleReviewRequests({ now: later });
    expect((await one(v)).status).toBe("scheduled");
  });

  it("counts a request that is still due, so two visits the same week get one request", async () => {
    const t = await makeTenant();
    const c = await t.customer();
    await t.visit(c);
    const v2 = await t.visit(c, plus(VISIT, HOUR));
    expect(await scheduleReviewRequests({ now: VISIT })).toEqual({ scheduled: 1, skipped: { duplicate: 1 } });
    expect((await one(v2)).skipReason).toBe("duplicate");
  });

  it("does not count a skipped or failed request", async () => {
    const t = await makeTenant();
    const c = await t.customer({ mail: null });
    const old = await t.visit(c, plus(VISIT, -5 * DAY)); // stale
    await scheduleReviewRequests({ now: VISIT });
    expect((await one(old)).skipReason).toBe("stale");
    const v = await t.visit(c);
    await scheduleReviewRequests({ now: VISIT });
    expect((await one(v)).status).toBe("scheduled");
  });

  it("applies per location: the same phone at another business is asked", async () => {
    const a = await makeTenant();
    await a.visit(await a.customer());
    const b = await makeTenant({ smsNumber: "+12015550181" });
    const vb = await b.visit(await b.customer());
    expect((await scheduleReviewRequests({ now: VISIT })).scheduled).toBe(2);
    expect((await one(vb)).status).toBe("scheduled");
  });
});

describe("the one reminder (FR-5, Flow 2 step 3)", () => {
  async function sentRequest(customer?: Parameters<Awaited<ReturnType<typeof makeTenant>>["customer"]>[0]) {
    const t = await makeTenant();
    const v = await t.visit(await t.customer(customer));
    await scheduleReviewRequests({ now: VISIT });
    await send(DUE);
    return { t, v };
  }

  it("reminds a non-clicker once, 3 days later, on the same channel", async () => {
    const { v } = await sentRequest();
    expect(await scheduleReminders({ now: plus(DUE, 3 * DAY - 60_000) })).toEqual({ scheduled: 0 });
    expect(await scheduleReminders({ now: plus(DUE, 3 * DAY) })).toEqual({ scheduled: 1 });
    const [, reminder] = await requestsOf(v);
    expect(reminder).toMatchObject({ attempt: 2, channel: "sms", scheduledFor: plus(DUE, 3 * DAY) });

    expect(await send(plus(DUE, 3 * DAY))).toMatchObject({ sent: 1 });
    expect(sms.sent).toHaveLength(2);
    expect(sms.sent[1].body).toMatch(/reminder/);
    expect(sms.sent[1].body).toContain(`${BASE}/r/${reminder.id}`);

    // Nothing after that: never a second reminder, never more than 2 messages per job.
    expect(await scheduleReminders({ now: plus(DUE, 30 * DAY) })).toEqual({ scheduled: 0 });
    await send(plus(DUE, 30 * DAY));
    expect(sms.sent).toHaveLength(2);
    expect(await requestsOf(v)).toHaveLength(2);
  });

  it("works with a shortened delay (Gate 1 test)", async () => {
    await sentRequest();
    const o = { reminderDelayMs: 60_000 };
    expect(await scheduleReminders({ now: plus(DUE, 60_000), ...o })).toEqual({ scheduled: 1 });
    expect(await send(plus(DUE, 60_000), o)).toMatchObject({ sent: 1 });
    expect(sms.sent).toHaveLength(2);
  });

  it("sends no reminder to a customer who clicked", async () => {
    const { v } = await sentRequest();
    const [rr] = await requestsOf(v);
    expect(await recordClick(rr.id, plus(DUE, HOUR))).toBe("https://g.page/r/acme/review");
    expect(await scheduleReminders({ now: plus(DUE, 4 * DAY) })).toEqual({ scheduled: 0 });
    expect(await requestsOf(v)).toHaveLength(1);
  });

  it("drops a scheduled reminder if the customer clicks before it goes out", async () => {
    const { v } = await sentRequest();
    await scheduleReminders({ now: plus(DUE, 3 * DAY) });
    const [rr] = await requestsOf(v);
    await recordClick(rr.id, plus(DUE, 3 * DAY));
    expect(await send(plus(DUE, 3 * DAY))).toMatchObject({ sent: 0, skipped: { clicked: 1 } });
    expect((await requestsOf(v))[1]).toMatchObject({ status: "skipped", skipReason: "clicked" });
    expect(sms.sent).toHaveLength(1);
  });

  it("sends no reminder to someone who opted out after the request", async () => {
    const { v } = await sentRequest();
    await scheduleReminders({ now: plus(DUE, 3 * DAY) });
    await db.update(s.customers).set({ optedOutAt: new Date() });
    // (only this test's tenant exists; afterEach removes it)
    expect(await send(plus(DUE, 3 * DAY))).toMatchObject({ skipped: { opted_out: 1 } });
    expect((await requestsOf(v))[1].skipReason).toBe("opted_out");
  });

  it("reminds by email after an SMS failure fell back to email, still at most 2 messages", async () => {
    const t = await makeTenant();
    const v = await t.visit(await t.customer());
    await scheduleReviewRequests({ now: VISIT });
    sms.fail = true;
    await send(DUE);
    await send(DUE); // fallback email goes out
    expect(await scheduleReminders({ now: plus(DUE, 3 * DAY) })).toEqual({ scheduled: 1 });
    await send(plus(DUE, 3 * DAY));
    expect(email.sent).toHaveLength(2);
    expect(sms.sent).toHaveLength(0);
    expect((await requestsOf(v)).filter((r) => r.status === "sent")).toHaveLength(2);
  });
});

const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) }) as never;

describe("redirect link /r/[id]", () => {
  it("counts the first click and redirects to the review form", async () => {
    const t = await makeTenant();
    const v = await t.visit(await t.customer());
    await scheduleReviewRequests({ now: VISIT });
    await send(DUE);
    const { id } = await one(v);

    const head = await clickHEAD(new Request(`${BASE}/r/${id}`, { method: "HEAD" }), ctx({ id }));
    expect(head.status).toBe(302);
    expect((await one(v)).clickedAt).toBeNull(); // HEAD probes are not clicks

    const res = await clickGET(new Request(`${BASE}/r/${id}`), ctx({ id }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://g.page/r/acme/review");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const first = (await one(v)).clickedAt;
    expect(first).not.toBeNull();

    await recordClick(id, plus(DUE, 5 * DAY));
    expect((await one(v)).clickedAt).toEqual(first); // first click kept
  });

  it("returns 404 for unknown, malformed or never-sent IDs", async () => {
    const t = await makeTenant();
    const v = await t.visit(await t.customer());
    await scheduleReviewRequests({ now: VISIT });
    const { id } = await one(v); // scheduled, not sent
    for (const bad of [id, "not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
      expect((await clickGET(new Request(`${BASE}/r/x`), ctx({ id: bad }))).status).toBe(404);
    }
    expect((await one(v)).clickedAt).toBeNull();
  });
});

describe("unsubscribe page /u/[token]", () => {
  it("GET shows a confirmation form and changes nothing; a bad token is rejected", async () => {
    const res = await unsubGET(new Request(`${BASE}/u/abc`), ctx({ token: "abc" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<form method="post">');
    expect((await unsubGET(new Request(`${BASE}/u/x`), ctx({ token: "<script>" }))).status).toBe(400);
    expect((await unsubPOST(new Request(`${BASE}/u/x`, { method: "POST" }), ctx({ token: "forged" }))).status).toBe(
      400,
    );
  });
});

describe("end to end", () => {
  it("runReviewRequestJobs schedules, reminds and sends; audit rows hold no contact data", async () => {
    const t = await makeTenant();
    const v = await t.visit(await t.customer());
    const o = { config };
    await runReviewRequestJobs(providers(), { now: VISIT, ...o });
    const r1 = await runReviewRequestJobs(providers(), { now: DUE, ...o });
    expect(r1.sent).toMatchObject({ sent: 1 });
    const r2 = await runReviewRequestJobs(providers(), { now: plus(DUE, 3 * DAY), ...o });
    expect(r2.reminders).toEqual({ scheduled: 1 });
    expect(r2.sent).toMatchObject({ sent: 1 });
    expect(sms.sent).toHaveLength(2);

    const ids = (await requestsOf(v)).map((r) => r.id);
    const audit = await db.select().from(s.auditLog).where(inArray(s.auditLog.entityId, ids));
    expect(audit.map((a) => a.action).sort()).toEqual(["scheduled", "scheduled", "sent", "sent"]);
    const text = JSON.stringify(audit);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain("5550110");
    expect(text).not.toContain(EMAIL);
  });
});
