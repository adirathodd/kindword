// End-to-end test of the inbound SMS webhook route against the Postgres in DATABASE_URL, with the real Twilio adapter
// and signature check. Only the Twilio REST call is faked (global fetch). Fake data only: 555-01xx numbers.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../../../db/client";
import * as s from "../../../../db/schema";
import { twilioSignature } from "../../../../sms/twilio";
import { POST } from "./route";

const SID = "AC00000000000000000000000000000000";
const TOKEN = "route-test-auth-token-0123456789";
const BASE = "https://reviews.example.test";
const HOOK = `${BASE}/api/sms/inbound`;
const PHONE = "+12015550170";
const NUMBER = "+12015550180";
const OTHER_NUMBER = "+12015550181";
const ADDRESSES = [PHONE, "+12015550171"];

type Sent = { from: string; to: string; body: string };
let sent: Sent[];
let twilioStatus: number;
const businessIds: string[] = [];
let locationId: string;
let otherLocationId: string;
let customerId: string;

const signedPost = (fields: Record<string, string>, opts: { sign?: string; url?: string } = {}) => {
  const params = new URLSearchParams({ AccountSid: SID, MessageSid: "SMfake", To: NUMBER, From: PHONE, ...fields });
  return new Request(opts.url ?? HOOK, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": opts.sign ?? twilioSignature(TOKEN, HOOK, params),
    },
    body: params,
  });
};

const suppression = () => db.select().from(s.suppressionList).where(inArray(s.suppressionList.address, ADDRESSES));

async function makeLocation(name: string, smsNumber: string) {
  const [b] = await db.insert(s.businesses).values({ name, vertical: "plumbing" }).returning();
  businessIds.push(b.id);
  const [l] = await db
    .insert(s.locations)
    .values({
      businessId: b.id,
      name: "Main",
      timezone: "America/New_York",
      reviewLink: "https://g.page/r/t",
      smsNumber,
    })
    .returning();
  return { businessId: b.id, locationId: l.id };
}

beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }));
beforeEach(async () => {
  vi.stubEnv("TWILIO_ACCOUNT_SID", SID);
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  vi.stubEnv("APP_BASE_URL", BASE);
  vi.stubEnv("TWILIO_WEBHOOK_URL", "");
  sent = [];
  twilioStatus = 201;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const f = new URLSearchParams(String(init.body));
    sent.push({ from: f.get("From")!, to: f.get("To")!, body: f.get("Body")! });
    return new Response(JSON.stringify(twilioStatus < 300 ? { sid: "SMout" } : { code: 30003 }), {
      status: twilioStatus,
    });
  });
  vi.spyOn(console, "error").mockImplementation(() => {});

  const a = await makeLocation("Alpha Plumbing", NUMBER);
  locationId = a.locationId;
  otherLocationId = (await makeLocation("Beta HVAC", OTHER_NUMBER)).locationId;
  const [att] = await db
    .insert(s.consentAttestations)
    .values({ businessId: a.businessId, signedAt: new Date(), documentRef: "a.pdf", listDescription: "estimates" })
    .returning();
  const [c] = await db
    .insert(s.customers)
    .values({
      locationId,
      businessId: a.businessId,
      phone: "201-555-0170",
      normalizedPhone: PHONE,
      consentMethod: "signed_estimate",
      consentWordingVersion: "v1",
      consentAt: new Date("2026-11-01T15:00:00Z"),
      consentEvidenceRef: "estimate.pdf",
      attestationId: att.id,
    })
    .returning();
  customerId = c.id;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await db.delete(s.businesses).where(inArray(s.businesses.id, businessIds.splice(0)));
  await db
    .delete(s.suppressionList)
    .where(and(isNull(s.suppressionList.locationId), inArray(s.suppressionList.address, ADDRESSES)));
});
afterAll(() => db.$client.end());

describe("POST /api/sms/inbound", () => {
  it("opts out on a phrase Twilio does not catch, confirms once from the location's number, replies empty TwiML", async () => {
    const res = await POST(signedPost({ Body: "Please opt out" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/xml");
    expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

    const rows = await suppression();
    expect(rows.map((r) => r.locationId).sort()).toEqual([locationId, null].sort());
    const [c] = await db.select().from(s.customers).where(eq(s.customers.id, customerId));
    expect(c.optedOutAt).not.toBeNull();
    expect(sent).toEqual([
      {
        from: NUMBER,
        to: PHONE,
        body: "You're unsubscribed from Alpha Plumbing texts. No more messages will be sent.",
      },
    ]);

    // Twilio retrying the same webhook, or a second STOP, changes nothing and sends nothing.
    expect((await POST(signedPost({ Body: "Please opt out" }))).status).toBe(200);
    expect((await POST(signedPost({ Body: "STOP" }))).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(await suppression()).toHaveLength(2);
  });

  it("does not send its own confirmation when Twilio's Advanced Opt-Out already replied", async () => {
    const res = await POST(signedPost({ Body: "STOP", OptOutType: "STOP" }));
    expect(res.status).toBe(200);
    expect(await suppression()).toHaveLength(2);
    expect(sent).toEqual([]);
  });

  it("only suppresses the location the text was sent to (plus platform-wide)", async () => {
    await POST(signedPost({ Body: "unsubscribe", To: OTHER_NUMBER }));
    const rows = await suppression();
    expect(rows.map((r) => r.locationId).sort()).toEqual([otherLocationId, null].sort());
    const [c] = await db.select().from(s.customers).where(eq(s.customers.id, customerId));
    expect(c.optedOutAt).toBeNull(); // the Alpha customer row is untouched; platform-wide row still blocks sends
  });

  it("ignores ordinary replies and HELP: no suppression, no text, empty TwiML", async () => {
    for (const Body of ["Thanks, great job!", "HELP", "I stopped by yesterday", ""]) {
      const res = await POST(signedPost({ Body }));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<Response></Response>");
    }
    expect(await suppression()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("rejects an unsigned or wrongly signed request with 403 and changes nothing", async () => {
    expect((await POST(signedPost({ Body: "STOP" }, { sign: "bad" }))).status).toBe(403);
    const params = new URLSearchParams({ AccountSid: SID, From: PHONE, To: NUMBER, Body: "STOP" });
    const unsigned = new Request(HOOK, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params,
    });
    expect((await POST(unsigned)).status).toBe(403);
    expect(await suppression()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("checks the signature against the configured URL, not the request URL", async () => {
    // Behind a proxy the request URL differs from what Twilio signed; the configured URL still validates.
    const res = await POST(signedPost({ Body: "STOP" }, { url: "http://internal:3000/api/sms/inbound" }));
    expect(res.status).toBe(200);
    expect(await suppression()).toHaveLength(2);
  });

  it("uses TWILIO_WEBHOOK_URL when set", async () => {
    vi.stubEnv("TWILIO_WEBHOOK_URL", "https://hooks.example.test/sms");
    expect((await POST(signedPost({ Body: "STOP" }))).status).toBe(403); // signed for HOOK, not the override
    const params = new URLSearchParams({ AccountSid: SID, From: PHONE, To: NUMBER, Body: "STOP" });
    const req = new Request(HOOK, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilioSignature(TOKEN, "https://hooks.example.test/sms", params),
      },
      body: params,
    });
    expect((await POST(req)).status).toBe(200);
  });

  it("keeps the opt-out and returns 500 when the confirmation send fails; a retry sends nothing", async () => {
    twilioStatus = 400;
    const res = await POST(signedPost({ Body: "opt out" }));
    expect(res.status).toBe(500);
    expect(await suppression()).toHaveLength(2);
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("code=30003");
    expect(logged).not.toContain("555"); // no phone numbers in logs

    twilioStatus = 201;
    sent = [];
    expect((await POST(signedPost({ Body: "opt out" }))).status).toBe(200);
    expect(sent).toEqual([]);
  });

  it("returns 503 and touches nothing when Twilio is not configured", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    const res = await POST(signedPost({ Body: "STOP" }));
    expect(res.status).toBe(503);
    expect(await suppression()).toEqual([]);
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).not.toContain(SID);
  });
});
