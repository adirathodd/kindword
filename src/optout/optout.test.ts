// Runs against the Postgres in DATABASE_URL. Fake data only: 555-01xx numbers, example.test emails.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import type { InboundSms, SmsProvider } from "../sms/provider";
import { TwilioSendError } from "../sms/twilio";
import { sendPendingConfirmations } from "./confirmations";
import { handleInboundSms, isOptOutMessage, isSuppressed, optOutEmail, unsubscribeToken } from "./optout";

process.env.UNSUBSCRIBE_SECRET ??= "test-only-secret-0123456789abcdef0123";

const PHONE = "+12015550100";
const EMAIL = "pat@example.test";
const A_NUMBER = "+12015550190";
const B_NUMBER = "+12015550191";
const TEST_ADDRESSES = [PHONE, EMAIL, "other@example.test", "+12015550101", "+12015550102", "+12015550199"];

// Signature check faked: a request is valid when it carries the right header.
class FakeSms implements SmsProvider {
  sent: { from: string; to: string; body: string }[] = [];
  // Next send outcome: "timeout" (Twilio may have taken it, outcome unknown), "refused" (Twilio answered, did not
  // take it). `accepted` records every text Twilio took, including timed-out ones, for sentSince.
  failNext: ("timeout" | "refused")[] = [];
  accepted: { from: string; to: string; at: Date }[] = [];
  lookups = 0;
  async sentSince(from: string, to: string, since: Date) {
    this.lookups++;
    return this.accepted.some((m) => m.from === from && m.to === to && m.at >= since);
  }
  async parseInbound(req: Request): Promise<InboundSms | null> {
    if (req.headers.get("x-fake-signature") !== "valid") return null;
    const f = await req.formData();
    return {
      from: String(f.get("From")),
      to: String(f.get("To")),
      body: String(f.get("Body")),
      providerHandled: f.get("OptOutType") === "STOP",
    };
  }
  async send(from: string, to: string, body: string) {
    const fail = this.failNext.shift();
    if (fail === "refused") throw Object.assign(new Error("refused"), { refused: true });
    this.accepted.push({ from, to, at: new Date() });
    if (fail === "timeout") throw new DOMException("timed out", "TimeoutError"); // Twilio queued it; we never heard
    this.sent.push({ from, to, body });
  }
}

const inbound = (body: string, { to = A_NUMBER, from = PHONE, signed = true, optOutType = "" } = {}) => {
  const form = new URLSearchParams({ From: from, To: to, Body: body, MessageSid: "SM-fake-1" });
  if (optOutType) form.set("OptOutType", optOutType);
  return new Request("https://example.test/api/sms/inbound", {
    method: "POST",
    headers: { "x-fake-signature": signed ? "valid" : "bad", "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
};

const businessIds: string[] = [];
async function makeTenant(name: string, smsNumber: string) {
  const [b] = await db.insert(s.businesses).values({ name, vertical: "plumbing" }).returning();
  businessIds.push(b.id);
  const [l] = await db
    .insert(s.locations)
    .values({
      businessId: b.id,
      name: "Main",
      timezone: "America/New_York",
      reviewLink: "https://g.page/r/test",
      smsNumber,
    })
    .returning();
  const [a] = await db
    .insert(s.consentAttestations)
    .values({ businessId: b.id, signedAt: new Date(), documentRef: "attest.pdf", listDescription: "signed estimates" })
    .returning();
  const [c] = await db
    .insert(s.customers)
    .values({
      locationId: l.id,
      businessId: b.id,
      phone: "(201) 555-0100",
      normalizedPhone: PHONE,
      email: "Pat@example.test",
      normalizedEmail: EMAIL,
      consentMethod: "signed_estimate",
      consentWordingVersion: "v1",
      consentAt: new Date("2026-11-01T15:00:00Z"),
      consentEvidenceRef: "estimate-0001.pdf",
      attestationId: a.id,
    })
    .returning();
  return { locationId: l.id, customerId: c.id };
}

let A: Awaited<ReturnType<typeof makeTenant>>;
let B: Awaited<ReturnType<typeof makeTenant>>;
let sms: FakeSms;

const suppressionRows = () =>
  db.select().from(s.suppressionList).where(inArray(s.suppressionList.address, TEST_ADDRESSES));
const auditOf = (locationId: string) => db.select().from(s.auditLog).where(eq(s.auditLog.locationId, locationId));
const customer = async (id: string) => (await db.select().from(s.customers).where(eq(s.customers.id, id)))[0];

beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
beforeEach(async () => {
  A = await makeTenant("Alpha Plumbing", A_NUMBER);
  B = await makeTenant("Beta HVAC", B_NUMBER);
  sms = new FakeSms();
});
afterEach(async () => {
  await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds.splice(0)));
  // Platform-wide rows have no location, so they don't cascade.
  await db
    .delete(s.suppressionList)
    .where(and(isNull(s.suppressionList.locationId), inArray(s.suppressionList.address, TEST_ADDRESSES)));
});
afterAll(() => db.$client.end());

describe("isOptOutMessage", () => {
  const yes = [
    "STOP",
    "stop",
    "Stop.",
    "STOP!!",
    "  stop  ",
    "stopall",
    "STOP ALL",
    "unsubscribe",
    "Unsubscribe me",
    "cancel",
    "END",
    "quit",
    "revoke",
    "optout",
    "opt out",
    "Opt-Out",
    "please opt out of this",
    "stop please",
    "Please stop texting me",
    "please don't stop", // false positive accepted: missing an opt-out costs more
    "s t o p",
    "STOP 🛑",
    // A keyword split by a space or punctuation inside a longer message (FR-8 strips both before matching).
    "un-subscribe me",
    "Please un subscribe me",
    "Un-Subscribe!",
    "re-voke consent",
    "please s-t-o-p texting",
    "I want to opt-out now",
    "can-cel please",
    "stop-all",
  ];
  const no = [
    "",
    "thanks!",
    "Great job, thank you",
    "I stopped by yesterday",
    "great weekend",
    "nonstop service",
    "option",
    "out of town",
    "HELP",
    "yes",
    "send the link again",
    // Adjacent words whose letters contain a keyword only across or inside a word.
    "we spent the day outside",
    "options are out there",
    "the subscription is fine",
    "can you call me",
  ];
  for (const m of yes) it(`matches ${JSON.stringify(m)}`, () => expect(isOptOutMessage(m)).toBe(true));
  for (const m of no) it(`does not match ${JSON.stringify(m)}`, () => expect(isOptOutMessage(m)).toBe(false));
});

describe("handleInboundSms", () => {
  it("STOP suppresses the customer at that location and platform-wide, audits, and confirms once", async () => {
    const r = await handleInboundSms(sms, inbound("stop please"));
    expect(r).toEqual({ status: "opted_out", confirmation: "sent" });

    const rows = await suppressionRows();
    expect(rows.map((x) => [x.locationId, x.channel, x.address]).sort()).toEqual(
      [
        [A.locationId, "sms", PHONE],
        [null, "sms", PHONE],
      ].sort(),
    );
    expect((await customer(A.customerId)).optedOutAt).toBeInstanceOf(Date);

    const audit = await auditOf(A.locationId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entity: "customer", entityId: A.customerId, action: "opted_out" });
    // Only the text fields: random UUIDs and timestamps can contain "555" or "0100" by chance.
    const auditText = audit.map(({ entity, action, actor, detail }) => ({ entity, action, actor, detail }));
    expect(JSON.stringify(auditText)).not.toMatch(/555|0100|example\.test|stop please/i);

    expect(sms.sent).toEqual([{ from: A_NUMBER, to: PHONE, body: expect.stringContaining("Alpha Plumbing") }]);
    expect(await isSuppressed(A.locationId, "sms", PHONE)).toBe(true);
  });

  it("a retried webhook adds no rows, no audit entry and no second confirmation", async () => {
    await handleInboundSms(sms, inbound("opt out"));
    const before = {
      rows: await suppressionRows(),
      audit: await auditOf(A.locationId),
      opted: await customer(A.customerId),
    };

    const retries = await Promise.all([
      handleInboundSms(sms, inbound("opt out")),
      handleInboundSms(sms, inbound("opt out")),
    ]);
    expect(retries).toEqual([
      { status: "opted_out", confirmation: "none" },
      { status: "opted_out", confirmation: "none" },
    ]);
    expect(await suppressionRows()).toEqual(before.rows);
    expect(await auditOf(A.locationId)).toEqual(before.audit);
    expect((await customer(A.customerId)).optedOutAt).toEqual(before.opted.optedOutAt);
    expect(sms.sent).toHaveLength(1);
  });

  it("concurrent first deliveries send exactly one confirmation", async () => {
    await Promise.all([1, 2, 3].map(() => handleInboundSms(sms, inbound("STOP!!"))));
    expect(sms.sent).toHaveLength(1);
    expect(await suppressionRows()).toHaveLength(2);
  });

  it("a Twilio-handled keyword is recorded but gets no confirmation from us", async () => {
    const r = await handleInboundSms(sms, inbound("STOP", { optOutType: "STOP" }));
    expect(r).toEqual({ status: "opted_out", confirmation: "provider" });
    expect(sms.sent).toEqual([]);
    expect(await suppressionRows()).toHaveLength(2);
    expect((await customer(A.customerId)).optedOutAt).toBeInstanceOf(Date);
  });

  it("a bad signature is rejected and stores nothing", async () => {
    const r = await handleInboundSms(sms, inbound("STOP", { signed: false }));
    expect(r).toEqual({ status: "rejected" });
    expect(await suppressionRows()).toEqual([]);
    expect(await auditOf(A.locationId)).toEqual([]);
    expect((await customer(A.customerId)).optedOutAt).toBeNull();
    expect(sms.sent).toEqual([]);
  });

  it("a non-opt-out message changes nothing and sends nothing", async () => {
    expect(await handleInboundSms(sms, inbound("thanks, great job"))).toEqual({ status: "ignored" });
    expect(await suppressionRows()).toEqual([]);
    expect(sms.sent).toEqual([]);
  });

  it("a keyword split inside a longer message, which Twilio's filter misses, still opts out and confirms", async () => {
    const r = await handleInboundSms(sms, inbound("Un-subscribe me please"));
    expect(r).toEqual({ status: "opted_out", confirmation: "sent" });
    expect(await isSuppressed(A.locationId, "sms", PHONE)).toBe(true);
    expect(await isSuppressed(B.locationId, "sms", PHONE)).toBe(true);
    expect((await customer(A.customerId)).optedOutAt).toBeInstanceOf(Date);
    expect(sms.sent).toHaveLength(1);
  });

  it("STOP to an unknown number still suppresses platform-wide", async () => {
    const r = await handleInboundSms(sms, inbound("stop", { to: "+12015550199" }));
    expect(r).toEqual({ status: "opted_out", confirmation: "sent" });
    expect((await suppressionRows()).map((x) => x.locationId)).toEqual([null]);
    expect(sms.sent[0].body).not.toMatch(/Alpha|Beta/);
  });

  it("an opt-out at business A touches nothing of business B's except the platform-wide entry", async () => {
    await handleInboundSms(sms, inbound("unsubscribe me", { to: A_NUMBER }));

    const bCustomer = await customer(B.customerId);
    expect(bCustomer.optedOutAt).toBeNull();
    expect(bCustomer.normalizedPhone).toBe(PHONE);
    expect(await auditOf(B.locationId)).toEqual([]);
    expect((await suppressionRows()).some((x) => x.locationId === B.locationId)).toBe(false);
    expect(await isSuppressed(B.locationId, "sms", PHONE)).toBe(true); // via the platform-wide entry

    // B's own number then gets its own opt-out and confirmation.
    expect(await handleInboundSms(sms, inbound("stop", { to: B_NUMBER }))).toEqual({
      status: "opted_out",
      confirmation: "sent",
    });
    expect((await customer(B.customerId)).optedOutAt).toBeInstanceOf(Date);
    expect(sms.sent.map((m) => m.from)).toEqual([A_NUMBER, B_NUMBER]);
  });
});

describe("confirmation outbox (audit F-9-2)", () => {
  const row = async () =>
    (await db.select().from(s.optOutConfirmations).where(eq(s.optOutConfirmations.locationId, A.locationId)))[0];
  // Ages the row as if `seconds` had passed since the opt-out and the last attempt.
  const age = (seconds: number) =>
    db.execute(sql`update optout_confirmations set created_at = created_at - make_interval(secs => ${seconds}),
      last_attempt_at = last_attempt_at - make_interval(secs => ${seconds}) where location_id = ${A.locationId}`);

  it("a Twilio timeout that lost the text: the opt-out holds and the job sends the one confirmation", async () => {
    // Timed out before Twilio took it: nothing reached Twilio.
    sms.send = async () => {
      throw new DOMException("timed out", "TimeoutError");
    };
    await expect(handleInboundSms(sms, inbound("STOP"))).rejects.toThrow();
    expect(await isSuppressed(A.locationId, "sms", PHONE)).toBe(true); // immediate, whatever happens to the text
    expect(await row()).toMatchObject({ status: "sending", attempts: 1 });

    sms = new FakeSms();
    expect(await sendPendingConfirmations(sms)).toMatchObject({ sent: 0, open: 1 }); // the attempt may still be in flight
    await age(90);
    expect(await sendPendingConfirmations(sms)).toMatchObject({ sent: 1, open: 0 });
    expect(sms.lookups).toBe(1); // checked Twilio first: the earlier outcome was unknown
    expect(sms.sent).toEqual([{ from: A_NUMBER, to: PHONE, body: expect.stringContaining("Alpha Plumbing") }]);
    expect(await row()).toMatchObject({ status: "sent", attempts: 2 });

    expect(await sendPendingConfirmations(sms)).toMatchObject({ sent: 0, open: 0 }); // never twice
    expect(sms.sent).toHaveLength(1);
  });

  it("a Twilio timeout after Twilio took the text: the job finds it and sends no second confirmation", async () => {
    sms.failNext = ["timeout"];
    await expect(handleInboundSms(sms, inbound("STOP"))).rejects.toThrow();
    await age(90);
    expect(await sendPendingConfirmations(sms)).toMatchObject({ sent: 0, alreadySent: 1, open: 0 });
    expect(sms.accepted).toHaveLength(1);
    expect(await row()).toMatchObject({ status: "sent" });
  });

  // F-72-1: a failed lookup is not a refused send. Twilio's message list answering 429 or 503 (TwilioSendError,
  // refused: true) used to mark the row pending, and a pending row is resent without a lookup, so a confirmation
  // Twilio took during the timed-out attempt went out a second time.
  it("a failed Twilio lookup after a timeout never leads to a resend without a lookup", async () => {
    sms.failNext = ["timeout"]; // Twilio took the text; we never heard
    await expect(handleInboundSms(sms, inbound("STOP"))).rejects.toThrow();
    await age(90);
    const lookup = sms.sentSince.bind(sms);
    sms.sentSince = async () => {
      throw new TwilioSendError(429, 20429);
    };
    expect(await sendPendingConfirmations(sms)).toMatchObject({ sent: 0, failed: 1, open: 1 });
    expect(await row()).toMatchObject({ status: "sending" }); // outcome still unknown
    expect(sms.accepted).toHaveLength(1);

    sms.sentSince = lookup;
    await age(90);
    expect(await sendPendingConfirmations(sms)).toMatchObject({ sent: 0, alreadySent: 1, open: 0 });
    expect(sms.accepted).toHaveLength(1); // never twice
    expect(await row()).toMatchObject({ status: "sent" });
  });

  it("a lookup that fails with a network error also leaves the outcome unknown", async () => {
    sms.failNext = ["timeout"];
    await expect(handleInboundSms(sms, inbound("STOP"))).rejects.toThrow();
    await age(90);
    sms.sentSince = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await sendPendingConfirmations(sms)).toMatchObject({ sent: 0, failed: 1, open: 1 });
    expect(await row()).toMatchObject({ status: "sending" });
    expect(sms.accepted).toHaveLength(1);
  });

  it("a refused send is retried at once, and never after 5 minutes", async () => {
    sms.failNext = ["refused"];
    await expect(handleInboundSms(sms, inbound("STOP"))).rejects.toThrow();
    expect(await row()).toMatchObject({ status: "pending" });
    sms.failNext = ["refused"];
    expect(await sendPendingConfirmations(sms)).toMatchObject({ sent: 0, open: 1 });
    expect(sms.lookups).toBe(0); // a refusal is a definite outcome: no lookup needed

    await age(300);
    expect(await sendPendingConfirmations(sms)).toMatchObject({ sent: 0, expired: 1, open: 0 });
    expect(sms.accepted).toHaveLength(0);
    expect(await row()).toMatchObject({ status: "expired", attempts: 2 });
  });

  it("concurrent job runs send one confirmation", async () => {
    sms.failNext = ["refused"];
    await expect(handleInboundSms(sms, inbound("STOP"))).rejects.toThrow();
    const runs = await Promise.all([sendPendingConfirmations(sms), sendPendingConfirmations(sms)]);
    expect(runs.reduce((n, r) => n + r.sent, 0)).toBe(1);
    expect(sms.sent).toHaveLength(1);
  });

  it("a confirmed, Twilio-handled or repeated opt-out leaves nothing for the job", async () => {
    await handleInboundSms(sms, inbound("STOP"));
    await handleInboundSms(sms, inbound("STOP"));
    await handleInboundSms(sms, inbound("STOP", { to: B_NUMBER, optOutType: "STOP" }));
    expect(await sendPendingConfirmations(sms)).toMatchObject({ sent: 0, open: 0 });
    expect(sms.sent).toHaveLength(1);
    expect(await row()).toMatchObject({ status: "sent", attempts: 1 });
  });
});

describe("optOutEmail", () => {
  it("unsubscribes the email at that location and platform-wide, once", async () => {
    const token = unsubscribeToken(A.locationId, "Pat@Example.test");
    // The token is opaque: neither the email nor the location ID appears in it, as text or in its decoded bytes.
    // (Matching short words like "pat" against the base64url text was flaky: random ciphertext can spell them.)
    expect(token).not.toContain("@");
    expect(token).not.toContain(A.locationId);
    const bytes = Buffer.from(token, "base64url").toString("latin1").toLowerCase();
    expect(bytes).not.toContain("pat@example.test");
    expect(bytes).not.toContain(A.locationId);
    expect(await optOutEmail(token)).toBe("opted_out");

    const rows = await suppressionRows();
    expect(rows.map((x) => [x.locationId, x.channel, x.address]).sort()).toEqual(
      [
        [A.locationId, "email", EMAIL],
        [null, "email", EMAIL],
      ].sort(),
    );
    expect((await customer(A.customerId)).optedOutAt).toBeInstanceOf(Date);
    expect(await auditOf(A.locationId)).toHaveLength(1);
    expect(await isSuppressed(B.locationId, "email", "PAT@example.test")).toBe(true);
    expect((await customer(B.customerId)).optedOutAt).toBeNull();
    expect(await isSuppressed(A.locationId, "sms", PHONE)).toBe(false); // email opt-out doesn't add a phone entry

    expect(await optOutEmail(token)).toBe("opted_out"); // second click: no new rows or audit
    expect(await suppressionRows()).toHaveLength(2);
    expect(await auditOf(A.locationId)).toHaveLength(1);
  });

  it("still works after the customer and its business are deleted", async () => {
    const token = unsubscribeToken(A.locationId, EMAIL);
    await db.delete(s.customers).where(eq(s.customers.id, A.customerId));
    expect(await optOutEmail(token)).toBe("opted_out");
    expect((await suppressionRows()).filter((x) => x.locationId === A.locationId)).toHaveLength(1);

    const gone = unsubscribeToken(B.locationId, "other@example.test");
    await db.delete(s.businesses).where(eq(s.businesses.id, (await customer(B.customerId)).businessId));
    expect(await optOutEmail(gone)).toBe("opted_out"); // location gone: platform-wide entry only
    const rows = await db.select().from(s.suppressionList).where(eq(s.suppressionList.address, "other@example.test"));
    expect(rows.map((x) => x.locationId)).toEqual([null]);
  });

  it("rejects a tampered or malformed token and stores nothing", async () => {
    const token = unsubscribeToken(A.locationId, EMAIL);
    const raw = Buffer.from(token, "base64url");
    raw[raw.length - 1] ^= 1;
    for (const bad of [raw.toString("base64url"), token.slice(0, 20), token.slice(0, -2), "", "abc", A.customerId]) {
      expect(await optOutEmail(bad)).toBe("invalid");
    }
    expect(await suppressionRows()).toEqual([]);
  });
});

describe("isSuppressed", () => {
  it("covers a location entry, a platform-wide entry and an unsuppressed address", async () => {
    await db.insert(s.suppressionList).values([
      { locationId: A.locationId, channel: "sms", address: "+12015550101", source: "test" },
      { locationId: null, channel: "sms", address: "+12015550102", source: "test" },
    ]);
    expect(await isSuppressed(A.locationId, "sms", "+12015550101")).toBe(true);
    expect(await isSuppressed(A.locationId, "sms", "(201) 555-0101")).toBe(true); // normalized before lookup
    expect(await isSuppressed(B.locationId, "sms", "+12015550101")).toBe(false); // location entry is per location
    expect(await isSuppressed(A.locationId, "sms", "+12015550102")).toBe(true);
    expect(await isSuppressed(B.locationId, "sms", "+12015550102")).toBe(true);
    expect(await isSuppressed(A.locationId, "sms", PHONE)).toBe(false);
    expect(await isSuppressed(A.locationId, "email", "+12015550102")).toBe(false); // channel-specific
  });
});
