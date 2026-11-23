// Unit tests for the Twilio adapter. No network: fetch is faked. Expected signatures were produced independently by
// Twilio's own Node library (twilio@5, webhooks.getExpectedTwilioSignature), not by this code.
import { describe, expect, it } from "vitest";
import { TwilioSendError, TwilioSms, twilioConfigFromEnv, twilioSignature } from "./twilio";

const SID = "AC00000000000000000000000000000000";
const TOKEN = "test-auth-token-0123456789abcdef";
const URL_ = "https://reviews.example.test/api/sms/inbound";
const config = { accountSid: SID, authToken: TOKEN, webhookUrl: URL_ };

const PARAMS = {
  MessageSid: "SM0123456789abcdef0123456789abcdef",
  AccountSid: SID,
  From: "+12015550100",
  To: "+12015550190",
  Body: "opt out please",
  NumMedia: "0",
  OptOutType: "",
};
const SIG = "JkvfSLMGOL4wYexxlX04kXA+AbE="; // from twilio@5 for PARAMS, TOKEN, URL_

const post = (params: Record<string, string>, signature: string | null, extra: Record<string, string> = {}) =>
  new Request(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(signature === null ? {} : { "x-twilio-signature": signature }),
      ...extra,
    },
    body: new URLSearchParams(params),
  });

describe("twilioSignature", () => {
  it("matches Twilio's documented example", () => {
    const params = new URLSearchParams({
      CallSid: "CA1234567890ABCDE",
      Caller: "+12349013030",
      Digits: "1234",
      From: "+12349013030",
      To: "+18005551212",
    });
    expect(twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", params)).toBe(
      "0/KCTR6DLpKmkAf8muzZqo1nDgQ=",
    );
  });

  it("matches Twilio's library for an inbound SMS, whatever the field order", () => {
    expect(twilioSignature(TOKEN, URL_, new URLSearchParams(PARAMS))).toBe(SIG);
    const reversed = new URLSearchParams(Object.entries(PARAMS).reverse());
    expect(twilioSignature(TOKEN, URL_, reversed)).toBe(SIG);
  });
});

describe("TwilioSms.parseInbound", () => {
  const sms = new TwilioSms(config);

  it("accepts a correctly signed message", async () => {
    expect(await sms.parseInbound(post(PARAMS, SIG))).toEqual({
      from: "+12015550100",
      to: "+12015550190",
      body: "opt out please",
      providerHandled: false,
    });
  });

  it("reports providerHandled only when Twilio says it handled a STOP", async () => {
    const p = { From: "+12015550100", To: "+12015550190", Body: "STOP", OptOutType: "STOP", AccountSid: SID };
    const sig = twilioSignature(TOKEN, URL_, new URLSearchParams(p));
    expect((await sms.parseInbound(post(p, sig)))?.providerHandled).toBe(true);
    const help = { ...p, Body: "HELP", OptOutType: "HELP" };
    const helpSig = twilioSignature(TOKEN, URL_, new URLSearchParams(help));
    expect((await sms.parseInbound(post(help, helpSig)))?.providerHandled).toBe(false);
  });

  it("treats a missing Body as an empty message", async () => {
    const p = { From: "+12015550100", To: "+12015550190", AccountSid: SID, NumMedia: "1" };
    const sig = twilioSignature(TOKEN, URL_, new URLSearchParams(p));
    expect((await sms.parseInbound(post(p, sig)))?.body).toBe("");
  });

  it.each([
    ["no signature header", post(PARAMS, null)],
    ["a wrong signature", post(PARAMS, "AAAAAAAAAAAAAAAAAAAAAAAAAAA=")],
    ["a signature of another length", post(PARAMS, "short")],
    ["a tampered body", post({ ...PARAMS, Body: "hello" }, SIG)],
    ["a forged From", post({ ...PARAMS, From: "+12015550101" }, SIG)],
    [
      "a JSON body",
      new Request(URL_, {
        method: "POST",
        headers: { "x-twilio-signature": SIG, "content-type": "application/json" },
        body: JSON.stringify(PARAMS),
      }),
    ],
    ["an oversized declared body", post(PARAMS, SIG, { "content-length": String(65 * 1024) })],
    ["an oversized body", post({ ...PARAMS, Pad: "x".repeat(70 * 1024) }, SIG)],
  ])("rejects %s", async (_name, req) => {
    expect(await sms.parseInbound(req)).toBeNull();
  });

  it("rejects a signature made with another auth token", async () => {
    const sig = twilioSignature("another-token", URL_, new URLSearchParams(PARAMS));
    expect(await sms.parseInbound(post(PARAMS, sig))).toBeNull();
  });

  it("rejects a signature made for another URL", async () => {
    const sig = twilioSignature(TOKEN, "https://attacker.example.test/api/sms/inbound", new URLSearchParams(PARAMS));
    expect(await sms.parseInbound(post(PARAMS, sig))).toBeNull();
  });

  it("rejects a validly signed message for another account", async () => {
    const p = { ...PARAMS, AccountSid: "AC11111111111111111111111111111111" };
    const sig = twilioSignature(TOKEN, URL_, new URLSearchParams(p));
    expect(await sms.parseInbound(post(p, sig))).toBeNull();
  });

  it("rejects a signed message with no From or To", async () => {
    const p = { AccountSid: SID, To: "+12015550190", Body: "STOP" };
    const sig = twilioSignature(TOKEN, URL_, new URLSearchParams(p));
    expect(await sms.parseInbound(post(p, sig))).toBeNull();
  });
});

describe("TwilioSms.send", () => {
  type Call = { url: string; init: RequestInit };
  const fakeFetch = (status: number, json: unknown, calls: Call[] = []) =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

  it("posts From, To and Body with basic auth and returns the message SID", async () => {
    const calls: Call[] = [];
    const sms = new TwilioSms(config, fakeFetch(201, { sid: "SMabc" }, calls));
    expect(await sms.send("+12015550190", "+12015550100", "hi")).toBe("SMabc");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`);
    const body = new URLSearchParams(String(calls[0].init.body));
    expect(Object.fromEntries(body)).toEqual({ From: "+12015550190", To: "+12015550100", Body: "hi" });
  });

  it("throws a TwilioSendError with only the status and Twilio code when refused", async () => {
    const sms = new TwilioSms(config, fakeFetch(400, { code: 21610, message: "Attempt to send to +12015550100" }));
    const err = await sms.send("+12015550190", "+12015550100", "hi").catch((e) => e);
    expect(err).toBeInstanceOf(TwilioSendError);
    expect(err.status).toBe(400);
    expect(err.code).toBe(21610);
    expect(err.message).not.toContain("555"); // never echoes the number
  });

  it("throws on a non-JSON error response", async () => {
    const f = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    const err = await new TwilioSms(config, f).send("+12015550190", "+12015550100", "hi").catch((e) => e);
    expect(err).toBeInstanceOf(TwilioSendError);
    expect(err.code).toBeNull();
  });
});

describe("twilioConfigFromEnv", () => {
  const env = { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, APP_BASE_URL: "https://reviews.example.test/" };

  it("derives the webhook URL from APP_BASE_URL", () => {
    expect(twilioConfigFromEnv(env)).toEqual(config);
  });

  it("prefers TWILIO_WEBHOOK_URL", () => {
    const webhookUrl = "https://hooks.example.test/sms";
    expect(twilioConfigFromEnv({ ...env, TWILIO_WEBHOOK_URL: webhookUrl }).webhookUrl).toBe(webhookUrl);
  });

  it.each([
    [{ ...env, TWILIO_ACCOUNT_SID: undefined }, /TWILIO_ACCOUNT_SID/],
    [{ ...env, TWILIO_ACCOUNT_SID: "MG00000000000000000000000000000000" }, /TWILIO_ACCOUNT_SID/],
    [{ ...env, TWILIO_AUTH_TOKEN: " " }, /TWILIO_AUTH_TOKEN/],
    [{ ...env, APP_BASE_URL: undefined }, /TWILIO_WEBHOOK_URL/],
    [{ ...env, APP_BASE_URL: "reviews.example.test" }, /TWILIO_WEBHOOK_URL/],
  ])("throws naming the bad setting, never its value (%#)", (e, msg) => {
    expect(() => twilioConfigFromEnv(e)).toThrow(msg);
    try {
      twilioConfigFromEnv(e);
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });
});
