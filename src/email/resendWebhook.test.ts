// Unit tests for Resend webhook verification. The expected signature for the Standard Webhooks example below was
// computed independently from the spec (HMAC-SHA256 over "id.timestamp.body"), not with this module.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseResendEvent, resendSignature, resendWebhookSecretFromEnv } from "./resendWebhook";

const KEY = Buffer.from("resend-unit-test-signing-key-012345");
const NOW = new Date("2026-11-26T12:00:00Z");
const TS = String(NOW.getTime() / 1000);

const req = (body: string, headers: Record<string, string>) =>
  new Request("https://reviews.example.test/api/email/events", { method: "POST", headers, body });

describe("resendSignature", () => {
  it("is base64 HMAC-SHA256 over id.timestamp.body with the decoded secret", () => {
    const body = '{"type":"email.delivered"}';
    const expected = createHmac("sha256", KEY).update(`msg_1.${TS}.${body}`).digest("base64");
    expect(resendSignature(KEY, "msg_1", TS, body)).toBe(expected);
  });
});

describe("parseResendEvent", () => {
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "abc-123", to: ["x@example.test"] } });
  const signed = (b = body, ts = TS, id = "msg_1") => ({
    "svix-id": id,
    "svix-timestamp": ts,
    "svix-signature": `v1,${resendSignature(KEY, id, ts, b)}`,
  });

  it("returns only the type and email ID of a signed event", async () => {
    expect(await parseResendEvent(req(body, signed()), KEY, NOW)).toEqual({
      type: "email.delivered",
      emailId: "abc-123",
    });
  });

  it("refuses replays outside 5 minutes, other keys and tampered bodies", async () => {
    const old = String(Number(TS) - 301);
    expect(await parseResendEvent(req(body, signed(body, old)), KEY, NOW)).toBeNull();
    expect(await parseResendEvent(req(body, signed()), Buffer.from("x".repeat(32)), NOW)).toBeNull();
    expect(await parseResendEvent(req(body.replace("abc", "abd"), signed()), KEY, NOW)).toBeNull();
    const h = signed();
    expect(await parseResendEvent(req(body, { ...h, "svix-id": "msg_2" }), KEY, NOW)).toBeNull();
  });

  it("refuses a non-POST, missing headers and an oversized body", async () => {
    const get = new Request("https://reviews.example.test/api/email/events", { headers: signed() });
    expect(await parseResendEvent(get, KEY, NOW)).toBeNull();
    expect(await parseResendEvent(req(body, { "svix-id": "msg_1", "svix-timestamp": TS }), KEY, NOW)).toBeNull();
    const big = JSON.stringify({ type: "email.delivered", pad: "x".repeat(300 * 1024) });
    expect(await parseResendEvent(req(big, signed(big)), KEY, NOW)).toBeNull();
  });

  it("returns a null email ID when the event has none", async () => {
    const b = JSON.stringify({ type: "domain.updated", data: {} });
    expect(await parseResendEvent(req(b, signed(b)), KEY, NOW)).toEqual({ type: "domain.updated", emailId: null });
  });
});

describe("resendWebhookSecretFromEnv", () => {
  it("decodes a whsec_ secret", () => {
    expect(resendWebhookSecretFromEnv({ RESEND_WEBHOOK_SECRET: `whsec_${KEY.toString("base64")}` })).toEqual(KEY);
  });

  it.each(["", "whsec_", "whsec_c2hvcnQ=", KEY.toString("base64"), "whsec_not base64!"])(
    "throws naming the setting for %j",
    (v) => {
      expect(() => resendWebhookSecretFromEnv({ RESEND_WEBHOOK_SECRET: v })).toThrow(/RESEND_WEBHOOK_SECRET/);
    },
  );
});
