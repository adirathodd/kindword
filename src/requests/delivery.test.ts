// Delivery receipts (FR-17 "delivered") through recordDelivery and the two webhook routes, against the Postgres in
// DATABASE_URL. Fake data only: example.test addresses, made-up provider IDs, no outside calls.
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client";
import * as s from "../db/schema";
import { POST as smsStatus } from "../app/api/sms/status/route";
import { POST as emailEvents } from "../app/api/email/events/route";
import { resendSignature } from "../email/resendWebhook";
import { twilioSignature } from "../sms/twilio";
import { DELIVERED_ACTION, recordDelivery } from "./delivery";
import { recordSmsFailure, scheduleReminders } from "./requests";

const SID = "AC00000000000000000000000000000000";
const TOKEN = "test-auth-token-0123456789abcdef";
const BASE = "https://reviews.example.test";
const STATUS_URL = `${BASE}/api/sms/status`;
const KEY = Buffer.from("delivery-test-signing-key-0123456789");
const WHSEC = `whsec_${KEY.toString("base64")}`;
const RUN = Date.now().toString(36);
let n = 0;
const businessIds: string[] = [];

async function tenant() {
  const [b] = await db.insert(s.businesses).values({ name: "Receipt Test HVAC", vertical: "hvac" }).returning();
  businessIds.push(b.id);
  const [l] = await db
    .insert(s.locations)
    .values({ businessId: b.id, name: "Main", timezone: "America/New_York", reviewLink: "https://g.page/r/t" })
    .returning();
  return { businessId: b.id, locationId: l.id };
}

async function request(
  t: Awaited<ReturnType<typeof tenant>>,
  o: { channel: "sms" | "email"; providerMessageId: string | null; status?: "sent" | "failed"; attempt?: 1 | 2 },
) {
  const [c] = await db
    .insert(s.customers)
    .values({
      locationId: t.locationId,
      businessId: t.businessId,
      email: `r${n}@example.test`,
      normalizedEmail: `r${n}@example.test`,
    })
    .returning();
  const [v] = await db
    .insert(s.visits)
    .values({
      customerId: c.id,
      locationId: t.locationId,
      visitAt: new Date(),
      source: "csv",
      externalVisitId: `d${n++}`,
    })
    .returning();
  const failed = o.status === "failed";
  const [rr] = await db
    .insert(s.reviewRequests)
    .values({
      visitId: v.id,
      scheduledFor: new Date(),
      sentAt: failed ? null : new Date(),
      channel: o.channel,
      status: o.status ?? "sent",
      attempt: o.attempt ?? 1,
      providerMessageId: o.providerMessageId,
    })
    .returning();
  return rr.id;
}

const receipts = (requestId: string) =>
  db
    .select()
    .from(s.auditLog)
    .where(and(eq(s.auditLog.entityId, requestId), eq(s.auditLog.action, DELIVERED_ACTION)));

const smsSid = () =>
  `SM${(RUN + String(n++))
    .padStart(32, "0")
    .slice(-32)
    .replace(/[^0-9a-f]/g, "a")}`;

beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
afterAll(() => db.delete(s.businesses).where(inArray(s.businesses.id, businessIds)));

describe("recordDelivery", () => {
  it("records one IDs-only receipt for a sent request, once", async () => {
    const t = await tenant();
    const id = await request(t, { channel: "email", providerMessageId: `em-${RUN}-1`, attempt: 2 });
    expect(await recordDelivery("email", `em-${RUN}-1`)).toBe("recorded");
    expect(await recordDelivery("email", `em-${RUN}-1`)).toBe("duplicate");
    const rows = await receipts(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      locationId: t.locationId,
      entity: "review_request",
      actor: "provider:resend",
      detail: "attempt=2;channel=email",
    });
  });

  it("two receipts at once write one row", async () => {
    const t = await tenant();
    const id = await request(t, { channel: "sms", providerMessageId: `sm-${RUN}-race` });
    const results = await Promise.all([
      recordDelivery("sms", `sm-${RUN}-race`),
      recordDelivery("sms", `sm-${RUN}-race`),
    ]);
    expect(results.sort()).toEqual(["duplicate", "recorded"]);
    expect(await receipts(id)).toHaveLength(1);
  });

  it("ignores unknown IDs, the other channel and requests not recorded as sent", async () => {
    const t = await tenant();
    const failed = await request(t, { channel: "sms", providerMessageId: `sm-${RUN}-failed`, status: "failed" });
    const email = await request(t, { channel: "email", providerMessageId: `same-${RUN}` });
    expect(await recordDelivery("sms", `nope-${RUN}`)).toBe("unknown");
    expect(await recordDelivery("sms", `same-${RUN}`)).toBe("unknown"); // the email's ID, reported as a text
    expect(await recordDelivery("sms", `sm-${RUN}-failed`)).toBe("unknown");
    expect(await recordDelivery("sms", "  ")).toBe("unknown");
    expect(await receipts(failed)).toHaveLength(0);
    expect(await receipts(email)).toHaveLength(0);
  });
});

describe("POST /api/sms/status", () => {
  beforeEach(() => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", SID);
    vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
    vi.stubEnv("APP_BASE_URL", BASE);
    vi.stubEnv("TWILIO_WEBHOOK_URL", "");
    vi.stubEnv("TWILIO_STATUS_CALLBACK_URL", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  const callback = (fields: Record<string, string>, opts: { token?: string; url?: string } = {}) => {
    const params = new URLSearchParams(fields);
    return new Request(STATUS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilioSignature(opts.token ?? TOKEN, opts.url ?? STATUS_URL, params),
      },
      body: params,
    });
  };
  const fields = (sid: string, status: string) => ({
    AccountSid: SID,
    MessageSid: sid,
    SmsSid: sid,
    MessageStatus: status,
    SmsStatus: status,
    From: "+12015550190",
    To: "+12015550101",
  });

  it("records a delivered text once and acknowledges every other status", async () => {
    const t = await tenant();
    const sid = smsSid();
    const id = await request(t, { channel: "sms", providerMessageId: sid });
    for (const st of ["queued", "sent"]) expect((await smsStatus(callback(fields(sid, st)))).status).toBe(204);
    expect(await receipts(id)).toHaveLength(0);
    expect((await smsStatus(callback(fields(sid, "delivered")))).status).toBe(204);
    expect((await smsStatus(callback(fields(sid, "delivered")))).status).toBe(204);
    expect(await receipts(id)).toHaveLength(1);
  });

  it("acknowledges a delivered text that is not a review request (an opt-out confirmation)", async () => {
    expect((await smsStatus(callback(fields(smsSid(), "delivered")))).status).toBe(204);
  });

  it("refuses bad signatures, another URL, another account and malformed SIDs, recording nothing", async () => {
    const t = await tenant();
    const sid = smsSid();
    const id = await request(t, { channel: "sms", providerMessageId: sid });
    const bad = [
      callback(fields(sid, "delivered"), { token: "another-token" }),
      callback(fields(sid, "delivered"), { url: `${BASE}/api/sms/inbound` }),
      callback({ ...fields(sid, "delivered"), AccountSid: "AC11111111111111111111111111111111" }),
      callback(fields("not-a-sid", "delivered")),
      new Request(STATUS_URL, { method: "POST", body: new URLSearchParams(fields(sid, "delivered")) }),
    ];
    for (const req of bad) expect((await smsStatus(req)).status).toBe(403);
    expect(await receipts(id)).toHaveLength(0);
  });

  it("answers 503 naming nothing secret when Twilio is not configured", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await smsStatus(callback(fields(smsSid(), "delivered")))).status).toBe(503);
    expect(errors.mock.calls.flat().join(" ")).not.toContain(TOKEN);
    errors.mockRestore();
  });
});

describe("POST /api/email/events", () => {
  beforeEach(() => vi.stubEnv("RESEND_WEBHOOK_SECRET", WHSEC));
  afterEach(() => vi.unstubAllEnvs());

  const event = (
    body: unknown,
    opts: { key?: Buffer; timestamp?: number; id?: string; signature?: string; raw?: string } = {},
  ) => {
    const raw = opts.raw ?? JSON.stringify(body);
    const id = opts.id ?? `msg_${RUN}${n++}`;
    const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
    return new Request(`${BASE}/api/email/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": id,
        "svix-timestamp": ts,
        "svix-signature": opts.signature ?? `v1,${resendSignature(opts.key ?? KEY, id, ts, raw)}`,
      },
      body: raw,
    });
  };
  const delivered = (emailId: string) => ({
    type: "email.delivered",
    created_at: new Date().toISOString(),
    data: { email_id: emailId, to: ["r@example.test"], subject: "How did we do?" },
  });

  it("records a delivered review email once and acknowledges other events", async () => {
    const t = await tenant();
    const emailId = `4ef9a417-${RUN}`;
    const id = await request(t, { channel: "email", providerMessageId: emailId });
    expect((await emailEvents(event({ ...delivered(emailId), type: "email.sent" }))).status).toBe(204);
    expect((await emailEvents(event({ ...delivered(emailId), type: "email.opened" }))).status).toBe(204);
    expect(await receipts(id)).toHaveLength(0);
    expect((await emailEvents(event(delivered(emailId)))).status).toBe(204);
    expect((await emailEvents(event(delivered(emailId)))).status).toBe(204); // Resend retry
    expect(await receipts(id)).toHaveLength(1);
    expect((await emailEvents(event(delivered(`owner-digest-${RUN}`)))).status).toBe(204); // not a request
  });

  it("accepts any of several signatures (secret rotation)", async () => {
    const t = await tenant();
    const emailId = `rot-${RUN}`;
    const id = await request(t, { channel: "email", providerMessageId: emailId });
    const raw = JSON.stringify(delivered(emailId));
    const ts = Math.floor(Date.now() / 1000);
    const good = resendSignature(KEY, "msg_rot", String(ts), raw);
    const req = event(null, { raw, id: "msg_rot", timestamp: ts, signature: `v1,AAAA v1a,xyz v1,${good}` });
    expect((await emailEvents(req)).status).toBe(204);
    expect(await receipts(id)).toHaveLength(1);
  });

  it("refuses a wrong key, a tampered body, an old timestamp and a missing signature", async () => {
    const t = await tenant();
    const emailId = `bad-${RUN}`;
    const id = await request(t, { channel: "email", providerMessageId: emailId });
    const raw = JSON.stringify(delivered(emailId));
    const ts = Math.floor(Date.now() / 1000);
    const bad = [
      event(delivered(emailId), { key: Buffer.from("another-signing-key-0123456789abc") }),
      event(null, {
        raw: raw.replace("email.delivered", "email.bounced"),
        signature: `v1,${resendSignature(KEY, "msg_t", String(ts), raw)}`,
        id: "msg_t",
        timestamp: ts,
      }),
      event(delivered(emailId), { timestamp: ts - 600 }),
      event(delivered(emailId), { timestamp: ts + 600 }),
      event(delivered(emailId), { signature: "" }),
      event(null, { raw: "not json" }),
    ];
    for (const req of bad) expect((await emailEvents(req)).status).toBe(403);
    expect(await receipts(id)).toHaveLength(0);
  });

  it("answers 503 when the signing secret is missing or malformed", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const v of ["", "not-a-secret", "whsec_"]) {
      vi.stubEnv("RESEND_WEBHOOK_SECRET", v);
      expect((await emailEvents(event(delivered("x")))).status).toBe(503);
    }
    expect(errors.mock.calls.flat().join(" ")).not.toContain(KEY.toString("base64"));
    errors.mockRestore();
  });
});

// FR-6 (owner decision 2026-11-27, audit O-66-4): a text Twilio took but later reported undelivered or failed counts
// as the text failing, so the request goes by email instead, once, and never on top of a text that arrived.
describe("carrier failure after Twilio took the text (FR-6)", () => {
  const PHONE = "+12015550142";
  async function textRequest(
    t: Awaited<ReturnType<typeof tenant>>,
    o: { email?: boolean; attempt?: 1 | 2; clicked?: boolean; phone?: string } = {},
  ) {
    const [a] = await db
      .insert(s.consentAttestations)
      .values({ businessId: t.businessId, signedAt: new Date(), documentRef: "a.pdf", listDescription: "estimates" })
      .returning();
    const mail = o.email === false ? null : `f${n}@example.test`;
    const phone = o.phone ?? `+1201555${String(1000 + (n % 9000)).padStart(4, "0")}`;
    const [c] = await db
      .insert(s.customers)
      .values({
        locationId: t.locationId,
        businessId: t.businessId,
        phone,
        normalizedPhone: phone,
        email: mail,
        normalizedEmail: mail,
        consentMethod: "signed_estimate",
        consentWordingVersion: "v1",
        consentAt: new Date(),
        consentEvidenceRef: "estimate.pdf",
        attestationId: a.id,
      })
      .returning();
    const [v] = await db
      .insert(s.visits)
      .values({
        customerId: c.id,
        locationId: t.locationId,
        visitAt: new Date(),
        source: "csv",
        externalVisitId: `f${n++}`,
      })
      .returning();
    const sid = smsSid();
    const sentAt = new Date(Date.now() - 60_000);
    if (o.attempt === 2)
      await db.insert(s.reviewRequests).values({
        visitId: v.id,
        scheduledFor: sentAt,
        sentAt,
        channel: "sms",
        status: "sent",
        attempt: 1,
        providerMessageId: smsSid(),
      });
    const [rr] = await db
      .insert(s.reviewRequests)
      .values({
        visitId: v.id,
        scheduledFor: sentAt,
        sentAt,
        channel: "sms",
        status: "sent",
        attempt: o.attempt ?? 1,
        providerMessageId: sid,
        clickedAt: o.clicked ? new Date() : null,
      })
      .returning();
    return { sid, rr, visitId: v.id, customer: c };
  }
  const rows = (visitId: string) => db.select().from(s.reviewRequests).where(eq(s.reviewRequests.visitId, visitId));
  const emails = async (visitId: string) => (await rows(visitId)).filter((r) => r.channel === "email");

  it("fails the text and schedules the request by email once, whatever repeats", async () => {
    const t = await tenant();
    const { sid, rr, visitId } = await textRequest(t);
    expect(await recordSmsFailure(sid, 30003)).toBe("failed");
    expect(await recordSmsFailure(sid, 30003)).toBe("ignored");
    expect(await recordSmsFailure(sid, null)).toBe("ignored");
    const [text] = (await rows(visitId)).filter((r) => r.id === rr.id);
    expect(text).toMatchObject({ status: "failed", sentAt: null, outcomeUnknown: false });
    const mail = await emails(visitId);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ status: "scheduled", attempt: 1 });
    const failed = await db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.entityId, rr.id), eq(s.auditLog.action, "failed")));
    expect(failed.map((r) => r.detail)).toEqual(["attempt=1;channel=sms;error=carrier_undelivered"]);
  });

  it("two failure callbacks at once schedule one email", async () => {
    const t = await tenant();
    const { sid, visitId } = await textRequest(t);
    const results = await Promise.all([recordSmsFailure(sid, 30005), recordSmsFailure(sid, 30005)]);
    expect(results.sort()).toEqual(["failed", "ignored"]);
    expect(await emails(visitId)).toHaveLength(1);
  });

  it("ignores a failure status for a text that was clicked or confirmed delivered", async () => {
    const t = await tenant();
    const clicked = await textRequest(t, { clicked: true });
    expect(await recordSmsFailure(clicked.sid, 30003)).toBe("ignored");
    const delivered = await textRequest(t);
    expect(await recordDelivery("sms", delivered.sid)).toBe("recorded");
    expect(await recordSmsFailure(delivered.sid, 30003)).toBe("ignored");
    for (const r of [clicked, delivered]) {
      expect((await rows(r.visitId)).find((x) => x.id === r.rr.id)?.status).toBe("sent");
      expect(await emails(r.visitId)).toHaveLength(0);
    }
  });

  it("sends no email for a failed reminder, a customer without email, or an opted-out customer", async () => {
    const t = await tenant();
    const reminder = await textRequest(t, { attempt: 2 });
    const noEmail = await textRequest(t, { email: false });
    const optedOut = await textRequest(t, { phone: "+12015550143" });
    await db.insert(s.suppressionList).values({
      locationId: null,
      channel: "email",
      address: optedOut.customer.normalizedEmail!,
      source: "customer_email",
    });
    for (const r of [reminder, noEmail, optedOut]) {
      expect(await recordSmsFailure(r.sid, 30003)).toBe("failed");
      expect(await emails(r.visitId)).toHaveLength(0);
    }
    await db.delete(s.suppressionList).where(eq(s.suppressionList.address, optedOut.customer.normalizedEmail!));
  });

  it("sends no email once the visit has a reminder (at most 2 messages per job)", async () => {
    const t = await tenant();
    const { sid, visitId } = await textRequest(t);
    await db
      .insert(s.reviewRequests)
      .values({ visitId, scheduledFor: new Date(), channel: "sms", status: "scheduled", attempt: 2 });
    expect(await recordSmsFailure(sid, 30003)).toBe("failed");
    expect(await emails(visitId)).toHaveLength(0);
  });

  it("records a Twilio 21610 as an opt-out and sends nothing else", async () => {
    const t = await tenant();
    const phone = "+12015550144";
    const { sid, visitId } = await textRequest(t, { phone });
    expect(await recordSmsFailure(sid, 21610)).toBe("failed");
    expect(await emails(visitId)).toHaveLength(0);
    const sup = await db.select().from(s.suppressionList).where(eq(s.suppressionList.address, phone));
    expect(sup.length).toBeGreaterThan(0);
    await db.delete(s.suppressionList).where(eq(s.suppressionList.address, phone));
  });

  it("does not schedule a text reminder for the failed text", async () => {
    const t = await tenant();
    const { sid, visitId } = await textRequest(t);
    expect(await recordSmsFailure(sid, 30003)).toBe("failed");
    await scheduleReminders({ reminderDelayMs: 0 });
    expect((await rows(visitId)).filter((r) => r.attempt === 2)).toHaveLength(0);
  });

  it("ignores unknown SIDs and email IDs", async () => {
    const t = await tenant();
    await request(t, { channel: "email", providerMessageId: `em-${RUN}-cf` });
    expect(await recordSmsFailure(`em-${RUN}-cf`, 30003)).toBe("unknown");
    expect(await recordSmsFailure(smsSid(), 30003)).toBe("unknown");
    expect(await recordSmsFailure("  ", null)).toBe("unknown");
  });

  describe("through POST /api/sms/status", () => {
    beforeEach(() => {
      vi.stubEnv("TWILIO_ACCOUNT_SID", SID);
      vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
      vi.stubEnv("APP_BASE_URL", BASE);
      vi.stubEnv("TWILIO_WEBHOOK_URL", "");
      vi.stubEnv("TWILIO_STATUS_CALLBACK_URL", "");
    });
    afterEach(() => vi.unstubAllEnvs());
    const signed = (fields: Record<string, string>) => {
      const params = new URLSearchParams({ AccountSid: SID, From: "+12015550190", To: PHONE, ...fields });
      return new Request(STATUS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": twilioSignature(TOKEN, STATUS_URL, params),
        },
        body: params,
      });
    };

    for (const status of ["undelivered", "failed"])
      it(`a signed "${status}" status sends the request by email instead`, async () => {
        const t = await tenant();
        const { sid, rr, visitId } = await textRequest(t);
        const res = await smsStatus(signed({ MessageSid: sid, MessageStatus: status, ErrorCode: "30003" }));
        expect(res.status).toBe(204);
        expect((await rows(visitId)).find((x) => x.id === rr.id)?.status).toBe("failed");
        expect(await emails(visitId)).toHaveLength(1);
      });

    it("an unsigned failure status changes nothing", async () => {
      const t = await tenant();
      const { sid, rr, visitId } = await textRequest(t);
      const params = new URLSearchParams({ AccountSid: SID, MessageSid: sid, MessageStatus: "undelivered" });
      const res = await smsStatus(new Request(STATUS_URL, { method: "POST", body: params }));
      expect(res.status).toBe(403);
      expect((await rows(visitId)).find((x) => x.id === rr.id)?.status).toBe("sent");
      expect(await emails(visitId)).toHaveLength(0);
    });
  });
});
