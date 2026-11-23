// Unit tests for the Resend adapter. No network: fetch is faked and sleep is instant.
import { describe, expect, it } from "vitest";
import type { EmailMessage } from "./provider";
import { ResendEmail, ResendSendError, formatFrom, resendConfigFromEnv } from "./resend";

const config = { apiKey: "re_test_0123456789abcdef", fromAddress: "requests@mail.example.test" };

const message = (over: Partial<EmailMessage> = {}): EmailMessage => ({
  to: "sam@example.test",
  fromName: "Acme Plumbing",
  subject: "How did we do?",
  text: "Leave a review: https://reviews.example.test/r/1",
  html: "<p>Leave a review</p>",
  headers: { "List-Unsubscribe": "<https://reviews.example.test/u/t>" },
  ...over,
});

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls, impl };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function adapter(responses: Array<Response | Error>, maxAttempts?: number) {
  const f = fakeFetch(responses);
  const sleeps: number[] = [];
  const email = new ResendEmail(config, {
    fetchImpl: f.impl,
    sleep: async (ms) => void sleeps.push(ms),
    maxAttempts,
  });
  return { email, calls: f.calls, sleeps };
}
const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);
const bodyOf = (c: Call) => JSON.parse(String(c.init.body));

describe("ResendEmail.send", () => {
  it("posts the message to Resend and returns its ID", async () => {
    const { email, calls } = adapter([json(200, { id: "em_123" })]);
    expect(await email.send(message({ idempotencyKey: "review-request/abc" }))).toBe("em_123");
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.url).toBe("https://api.resend.com/emails");
    expect(c.init.method).toBe("POST");
    expect(header(c, "authorization")).toBe(`Bearer ${config.apiKey}`);
    expect(header(c, "content-type")).toBe("application/json");
    expect(header(c, "idempotency-key")).toBe("review-request/abc");
    expect(bodyOf(c)).toEqual({
      from: '"Acme Plumbing" <requests@mail.example.test>',
      to: ["sam@example.test"],
      subject: "How did we do?",
      text: "Leave a review: https://reviews.example.test/r/1",
      html: "<p>Leave a review</p>",
      headers: { "List-Unsubscribe": "<https://reviews.example.test/u/t>" },
    });
  });

  it("leaves headers out when there are none, and makes up an idempotency key when none is given", async () => {
    const { email, calls } = adapter([json(200, { id: "a" }), json(200, { id: "b" })]);
    await email.send(message({ headers: {} }));
    await email.send(message({ headers: {} }));
    expect(bodyOf(calls[0])).not.toHaveProperty("headers");
    const k1 = header(calls[0], "idempotency-key");
    const k2 = header(calls[1], "idempotency-key");
    expect(k1).toMatch(/^[0-9a-f-]{36}$/);
    expect(k1).not.toBe(k2); // two sends of a message that may repeat (e.g. sign-in links) are two emails
  });

  it("resolves without an ID when Resend returns none", async () => {
    const { email } = adapter([json(200, {})]);
    expect(await email.send(message())).toBeUndefined();
  });

  it("retries 429 and 5xx with the same idempotency key, honoring Retry-After", async () => {
    const { email, calls, sleeps } = adapter([
      json(429, { name: "rate_limit_exceeded", message: "Too many requests" }, { "retry-after": "2" }),
      json(503, { name: "internal_server_error" }),
      json(200, { id: "em_9" }),
    ]);
    expect(await email.send(message())).toBe("em_9");
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => header(c, "idempotency-key"))).size).toBe(1);
    expect(sleeps).toEqual([2000, 1000]);
  });

  it("retries network errors and timeouts, then gives up with a safe error", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const { email, calls, sleeps } = adapter([new TypeError("fetch failed"), timeout, timeout]);
    const err = await email.send(message()).catch((e) => e);
    expect(err).toBeInstanceOf(ResendSendError);
    expect(err).toMatchObject({ status: 0, code: "timeout", retryable: true });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("caps a long Retry-After instead of waiting it out", async () => {
    const { email, sleeps } = adapter([json(429, {}, { "retry-after": "3600" }), json(200, { id: "x" })]);
    await email.send(message());
    expect(sleeps).toEqual([10_000]);
  });

  it("does not retry a refused message, and never puts Resend's message text in the error", async () => {
    const { email, calls } = adapter([
      json(422, { statusCode: 422, name: "validation_error", message: "Invalid `to` field: sam@example.test" }),
    ]);
    const err = await email.send(message()).catch((e) => e);
    expect(err).toBeInstanceOf(ResendSendError);
    expect(err).toMatchObject({ status: 422, code: "validation_error", retryable: false });
    expect(String(err.message)).not.toContain("sam@example.test");
    expect(calls).toHaveLength(1);
  });

  it("refuses an API key error without retrying", async () => {
    const { email, calls } = adapter([json(401, { name: "missing_api_key" })]);
    await expect(email.send(message())).rejects.toMatchObject({ status: 401, code: "missing_api_key" });
    expect(calls).toHaveLength(1);
  });

  it("drops an error name that is not a plain code", async () => {
    const { email } = adapter([json(400, { name: "sam@example.test" })]);
    await expect(email.send(message())).rejects.toMatchObject({ status: 400, code: null });
  });

  it("handles a non-JSON error body", async () => {
    const { email } = adapter([new Response("<html>bad gateway</html>", { status: 502 })], 1);
    await expect(email.send(message())).rejects.toMatchObject({ status: 502, code: null, retryable: true });
  });

  it.each([
    ["a list of recipients", { to: "a@example.test, b@example.test" }, "invalid_recipient"],
    ["a recipient with a display name", { to: "Sam <sam@example.test>" }, "invalid_recipient"],
    ["a recipient with a line break", { to: "sam@example.test\r\nBcc: x@example.test" }, "invalid_recipient"],
    ["a subject with a line break", { subject: "Hi\r\nBcc: x@example.test" }, "invalid_subject"],
    ["an empty subject", { subject: "  " }, "invalid_subject"],
    ["no body", { text: "", html: "" }, "empty_body"],
    ["a header value with a line break", { headers: { "X-A": "1\r\nBcc: x@example.test" } }, "invalid_header"],
    ["a malformed header name", { headers: { "X A:": "1" } }, "invalid_header"],
    ["an empty idempotency key", { idempotencyKey: "" }, "invalid_idempotency_key"],
    ["an over-long idempotency key", { idempotencyKey: "k".repeat(257) }, "invalid_idempotency_key"],
  ])("refuses %s before calling Resend", async (_label, over, code) => {
    const { email, calls } = adapter([]);
    await expect(email.send(message(over as Partial<EmailMessage>))).rejects.toMatchObject({ status: 0, code });
    expect(calls).toHaveLength(0);
  });
});

describe("formatFrom", () => {
  it("quotes the display name", () => {
    expect(formatFrom("Acme Plumbing, LLC", "a@mail.example.test")).toBe('"Acme Plumbing, LLC" <a@mail.example.test>');
  });

  it("strips characters that could change the address or add a header", () => {
    expect(formatFrom('Evil" <x@evil.test>\r\nBcc: y@evil.test', "a@mail.example.test")).toBe(
      '"Evil x@evil.test Bcc: y@evil.test" <a@mail.example.test>',
    );
  });

  it("uses the bare address when the name is empty", () => {
    expect(formatFrom(' "" ', "a@mail.example.test")).toBe("a@mail.example.test");
  });

  it("keeps non-English names", () => {
    expect(formatFrom("Plomería José", "a@mail.example.test")).toBe('"Plomería José" <a@mail.example.test>');
  });
});

describe("resendConfigFromEnv", () => {
  const env = { RESEND_API_KEY: " re_abc_123 ", EMAIL_FROM_ADDRESS: " Requests@Mail.Example.test " };

  it("reads and trims the settings", () => {
    expect(resendConfigFromEnv(env)).toEqual({ apiKey: "re_abc_123", fromAddress: "requests@mail.example.test" });
  });

  it("names the missing or malformed setting, never its value", () => {
    expect(() => resendConfigFromEnv({ ...env, RESEND_API_KEY: "" })).toThrow(/RESEND_API_KEY/);
    expect(() => resendConfigFromEnv({ ...env, RESEND_API_KEY: "sk_secret_value" })).toThrow(
      /^RESEND_API_KEY missing or not a re_… API key$/,
    );
    expect(() => resendConfigFromEnv({ ...env, EMAIL_FROM_ADDRESS: undefined })).toThrow(/EMAIL_FROM_ADDRESS/);
    expect(() => resendConfigFromEnv({ ...env, EMAIL_FROM_ADDRESS: "Acme <a@mail.example.test>" })).toThrow(
      /EMAIL_FROM_ADDRESS/,
    );
  });
});
