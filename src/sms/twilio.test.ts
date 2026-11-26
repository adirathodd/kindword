// Unit tests for the Twilio adapter. No network: fetch is faked. Expected signatures were produced independently by
// Twilio's own Node library (twilio@5, webhooks.getExpectedTwilioSignature), not by this code.
import { describe, expect, it } from "vitest";
import { TwilioSendError, TwilioSms, twilioConfigFromEnv, twilioSignature } from "./twilio";

const SID = "AC00000000000000000000000000000000";
const TOKEN = "test-auth-token-0123456789abcdef";
const URL_ = "https://reviews.example.test/api/sms/inbound";
const config = { accountSid: SID, authToken: TOKEN, webhookUrl: URL_ };
const STATUS_URL = "https://reviews.example.test/api/sms/status";

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

describe("TwilioSms.parseStatusCallback", () => {
  const MSG = "SM0123456789abcdef0123456789abcdef";
  const fields = { AccountSid: SID, MessageSid: MSG, MessageStatus: "delivered", To: "+12015550100" };
  const req = (params: Record<string, string>, url = STATUS_URL, token = TOKEN) =>
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilioSignature(token, url, new URLSearchParams(params)),
      },
      body: new URLSearchParams(params),
    });

  it("reads the SID and status of a signed callback", async () => {
    const sms = new TwilioSms({ ...config, statusCallbackUrl: STATUS_URL });
    expect(await sms.parseStatusCallback(req(fields))).toEqual({ messageSid: MSG, status: "delivered" });
    const legacy = { AccountSid: SID, SmsSid: MSG, SmsStatus: "Undelivered" };
    expect(await sms.parseStatusCallback(req(legacy))).toEqual({ messageSid: MSG, status: "undelivered" });
  });

  it("refuses an inbound-message signature, another token or account, and a bad SID", async () => {
    const sms = new TwilioSms({ ...config, statusCallbackUrl: STATUS_URL });
    expect(await sms.parseStatusCallback(req(fields, URL_))).toBeNull();
    expect(await sms.parseStatusCallback(req(fields, STATUS_URL, "other-token"))).toBeNull();
    expect(await sms.parseStatusCallback(req({ ...fields, AccountSid: `AC${"1".repeat(32)}` }))).toBeNull();
    expect(await sms.parseStatusCallback(req({ ...fields, MessageSid: "SM123" }))).toBeNull();
    expect(await sms.parseStatusCallback(req({ ...fields, MessageStatus: "" }))).toBeNull();
  });

  it("accepts nothing when no status callback URL is configured", async () => {
    expect(await new TwilioSms(config).parseStatusCallback(req(fields))).toBeNull();
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

  it("asks for a status callback when one is configured", async () => {
    const calls: Call[] = [];
    const sms = new TwilioSms({ ...config, statusCallbackUrl: STATUS_URL }, fakeFetch(201, { sid: "SMabc" }, calls));
    await sms.send("+12015550190", "+12015550100", "hi");
    expect(new URLSearchParams(String(calls[0].init.body)).get("StatusCallback")).toBe(STATUS_URL);
  });

  it("throws a TwilioSendError with only the status and Twilio code when refused", async () => {
    const sms = new TwilioSms(config, fakeFetch(400, { code: 21610, message: "Attempt to send to +12015550100" }));
    const err = await sms.send("+12015550190", "+12015550100", "hi").catch((e) => e);
    expect(err).toBeInstanceOf(TwilioSendError);
    expect(err.status).toBe(400);
    expect(err.code).toBe(21610);
    expect(err.message).not.toContain("555"); // never echoes the number
  });

  // SPEC Integrations: "Every outside call is retried with backoff". Only responses that mean Twilio did not take the
  // message are retried, because Twilio's API has no idempotency key.
  const seq = (steps: (number | Error)[], calls: number[] = [], headers: Record<string, string> = {}) =>
    (async () => {
      const step = steps[calls.length];
      calls.push(1);
      if (step instanceof Error) throw step;
      return new Response(JSON.stringify(step < 300 ? { sid: "SMok" } : { code: step === 429 ? 20429 : 20503 }), {
        status: step,
        headers,
      });
    }) as unknown as typeof fetch;
  const noSleep = (sleeps: number[] = []) => ({ sleep: async (ms: number) => void sleeps.push(ms) });

  it.each([429, 503])("retries a %i with backoff and returns the SID of the retried send", async (status) => {
    const calls: number[] = [];
    const sleeps: number[] = [];
    const sms = new TwilioSms(config, seq([status, status, 201], calls), noSleep(sleeps));
    expect(await sms.send("+12015550190", "+12015550100", "hi")).toBe("SMok");
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("honors Retry-After, capped so the inbound webhook still answers in time", async () => {
    const sleeps: number[] = [];
    const sms = new TwilioSms(config, seq([429, 429, 201], [], { "retry-after": "1" }), noSleep(sleeps));
    expect(await sms.send("+12015550190", "+12015550100", "hi")).toBe("SMok");
    expect(sleeps).toEqual([1000, 1000]);
    const capped: number[] = [];
    await new TwilioSms(config, seq([429, 201], [], { "retry-after": "60" }), noSleep(capped)).send("+1", "+1", "hi");
    expect(capped).toEqual([2000]);
  });

  it("gives up after 3 attempts with the last TwilioSendError", async () => {
    const calls: number[] = [];
    const err = await new TwilioSms(config, seq([503, 503, 503, 201], calls), noSleep())
      .send("+12015550190", "+12015550100", "hi")
      .catch((e) => e);
    expect(err).toBeInstanceOf(TwilioSendError);
    expect(err.status).toBe(503);
    expect(calls).toHaveLength(3);
  });

  it.each([
    ["a refusal (400)", 400],
    ["a 500, which may come after Twilio queued the text", 500],
    ["a 502", 502],
  ])("does not retry %s", async (_label, status) => {
    const calls: number[] = [];
    await new TwilioSms(config, seq([status, 201], calls), noSleep()).send("+1", "+1", "hi").catch(() => {});
    expect(calls).toHaveLength(1);
  });

  it("does not retry a timeout or network error (Twilio may already have the text)", async () => {
    for (const e of [new DOMException("timed out", "TimeoutError"), new TypeError("fetch failed")]) {
      const calls: number[] = [];
      const err = await new TwilioSms(config, seq([e, 201], calls), noSleep()).send("+1", "+1", "hi").catch((x) => x);
      expect(err).toBe(e);
      expect(calls).toHaveLength(1);
    }
  });

  it.each([
    [400, true],
    [404, true],
    [429, true],
    [503, true],
    [500, false],
    [502, false],
    [504, false],
  ])("marks a final status %i as refused=%s (only a refusal may fall back to email)", async (status, refused) => {
    const err = await new TwilioSms(config, fakeFetch(status, { code: 1 }), noSleep())
      .send("+1", "+1", "hi")
      .catch((e) => e);
    expect(err).toBeInstanceOf(TwilioSendError);
    expect(err.refused).toBe(refused);
  });

  it("marks 21610 as a recipient Twilio has opted out", async () => {
    const err = await new TwilioSms(config, fakeFetch(400, { code: 21610 })).send("+1", "+1", "hi").catch((e) => e);
    expect(err.recipientOptedOut).toBe(true);
    const other = await new TwilioSms(config, fakeFetch(400, { code: 30003 })).send("+1", "+1", "hi").catch((e) => e);
    expect(other.recipientOptedOut).toBe(false);
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

  it("derives the webhook and status callback URLs from APP_BASE_URL", () => {
    expect(twilioConfigFromEnv(env)).toEqual({ ...config, statusCallbackUrl: STATUS_URL });
  });

  it("prefers TWILIO_STATUS_CALLBACK_URL, else uses the webhook URL's origin", () => {
    const statusCallbackUrl = "https://hooks.example.test/status";
    expect(twilioConfigFromEnv({ ...env, TWILIO_STATUS_CALLBACK_URL: statusCallbackUrl }).statusCallbackUrl).toBe(
      statusCallbackUrl,
    );
    expect(
      twilioConfigFromEnv({ ...env, APP_BASE_URL: undefined, TWILIO_WEBHOOK_URL: "https://hooks.example.test/sms" })
        .statusCallbackUrl,
    ).toBe("https://hooks.example.test/api/sms/status");
    expect(() => twilioConfigFromEnv({ ...env, TWILIO_STATUS_CALLBACK_URL: "hooks.example.test" })).toThrow(
      /TWILIO_STATUS_CALLBACK_URL/,
    );
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
