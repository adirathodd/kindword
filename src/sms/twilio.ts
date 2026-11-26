// Twilio adapter for the SMS provider boundary (SPEC FR-6, FR-8; Integrations: Twilio). No SDK: the webhook
// signature is an HMAC-SHA1 over the configured URL plus the sorted form fields, and sending is one REST call.
// Nothing here logs or returns phone numbers, message text or the auth token.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ConfirmationSms } from "../optout/confirmations";
import type { InboundSms } from "./provider";

const MAX_BODY_BYTES = 64 * 1024; // Twilio webhooks are a few KB; anything larger is not from Twilio
const SEND_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 2_000; // short: the inbound webhook sends its confirmation inline and Twilio waits 15 s at most

// SPEC Integrations: "Every outside call is retried with backoff". Twilio's REST API has no idempotency key, so only
// responses that mean Twilio did not take the message are retried: 429 (rate limited) and 503 (unavailable). A
// timeout, a lost connection or another 5xx may come after Twilio queued the text, so those are never retried (a
// retry could text the customer twice).
const retryableStatus = (status: number) => status === 429 || status === 503;

function delayFor(attempt: number, retryAfter: string | null) {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(ms, MAX_DELAY_MS);
}

export type TwilioOptions = {
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
};

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  // The exact public URL configured as the number's or Messaging Service's incoming-message webhook. Twilio signs
  // this URL, so it is fixed by config rather than read from the request (which a proxy may rewrite).
  webhookUrl: string;
  // Where Twilio posts message status changes (FR-17 "delivered"). Sent as StatusCallback with every message, and the
  // URL the callback's signature is checked against. Unset: no callback is requested and none is accepted.
  statusCallbackUrl?: string;
};

// A signed status callback for one message we sent (https://www.twilio.com/docs/messaging/guides/track-outbound-message-status).
// MessageStatus is queued, sending, sent, delivered, undelivered, failed, read or canceled.
export type SmsStatus = { messageSid: string; status: string };

// Twilio's request signature: base64(HMAC-SHA1(authToken, url + each key+value, keys sorted)).
export function twilioSignature(authToken: string, url: string, params: URLSearchParams) {
  const pairs = [...params.entries()].sort(([a, av], [b, bv]) =>
    a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
  );
  const data = url + pairs.map(([k, v]) => k + v).join("");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

function sameSignature(expected: string, given: string) {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Raised when Twilio refuses a message. Carries Twilio's numeric error code (e.g. 21610: recipient replied STOP)
// and the HTTP status only, so it is safe to log.
export class TwilioSendError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
  ) {
    super(`Twilio send failed: status=${status} code=${code ?? "none"}`);
    this.name = "TwilioSendError";
  }

  // Twilio answered and did not take the message: a 4xx (bad number, opted out, rate limited) or 503. A 500, 502 or
  // 504 may come after Twilio queued the text, so it is not a refusal and a request must not switch to email (FR-6).
  get refused() {
    return (this.status >= 400 && this.status < 500) || this.status === 503;
  }

  // 21610: Twilio has this recipient opted out (they texted one of its keywords) and blocks every send to them.
  get recipientOptedOut() {
    return this.code === 21610;
  }
}

export class TwilioSms implements ConfirmationSms {
  constructor(
    private readonly config: TwilioConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: TwilioOptions = {},
  ) {}

  // The form fields of a request Twilio signed for `url` and this account; null for anything else.
  private async signedParams(req: Request, url: string): Promise<URLSearchParams | null> {
    if (req.method !== "POST") return null;
    const signature = req.headers.get("x-twilio-signature");
    if (!signature) return null;
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded"))
      return null;
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return null;
    const raw = await req.text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return null;

    const params = new URLSearchParams(raw);
    if (!sameSignature(twilioSignature(this.config.authToken, url, params), signature)) return null;
    // A signed request for another Twilio account (a shared auth token would be a misconfiguration) is still refused.
    if (params.get("AccountSid") !== this.config.accountSid) return null;
    return params;
  }

  async parseInbound(req: Request): Promise<InboundSms | null> {
    const params = await this.signedParams(req, this.config.webhookUrl);
    if (!params) return null;

    const from = params.get("From");
    const to = params.get("To");
    if (!from || !to) return null;
    return {
      from,
      to,
      body: params.get("Body") ?? "",
      // Set only when Advanced Opt-Out is on and Twilio itself opted the sender out and replied (see provider.ts).
      providerHandled: params.get("OptOutType")?.toUpperCase() === "STOP",
    };
  }

  // Checks the signature against statusCallbackUrl. Reads only the message SID and status, never the numbers.
  async parseStatusCallback(req: Request): Promise<SmsStatus | null> {
    if (!this.config.statusCallbackUrl) return null;
    const params = await this.signedParams(req, this.config.statusCallbackUrl);
    if (!params) return null;
    const messageSid = params.get("MessageSid") ?? params.get("SmsSid");
    const status = (params.get("MessageStatus") ?? params.get("SmsStatus"))?.toLowerCase();
    if (!messageSid || !/^(SM|MM)[0-9a-fA-F]{32}$/.test(messageSid) || !status) return null;
    return { messageSid, status };
  }

  async send(from: string, to: string, body: string): Promise<string | void> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const maxAttempts = this.options.maxAttempts ?? MAX_ATTEMPTS;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.sendOnce(from, to, body);
      } catch (e) {
        if (!(e instanceof TwilioRetryable) || attempt >= maxAttempts) throw e instanceof TwilioRetryable ? e.error : e;
        await sleep(delayFor(attempt, e.retryAfter));
      }
    }
  }

  // Lists messages from `from` to `to` (Twilio returns the newest first) and checks for one created at or after
  // `since`. Resolves an opt-out confirmation whose send timed out (audit F-9-2). Only dates are read.
  async sentSince(from: string, to: string, since: Date): Promise<boolean> {
    const { accountSid, authToken } = this.config;
    const query = new URLSearchParams({ From: from, To: to, PageSize: "20" });
    const res = await this.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json?${query}`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      },
    );
    const json = (await res.json().catch(() => null)) as {
      messages?: { date_created?: unknown }[];
      code?: unknown;
    } | null;
    if (!res.ok || !Array.isArray(json?.messages))
      throw new TwilioSendError(res.status, typeof json?.code === "number" ? json.code : null);
    // date_created has whole seconds, so `since` is floored to its second. No wider margin: a customer often replies
    // STOP seconds after a review request, and that request must not count as the confirmation.
    const after = Math.floor(since.getTime() / 1000) * 1000;
    return json.messages.some((m) => typeof m.date_created === "string" && Date.parse(m.date_created) >= after);
  }

  private async sendOnce(from: string, to: string, body: string): Promise<string | void> {
    const { accountSid, authToken } = this.config;
    const res = await this.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          From: from,
          To: to,
          Body: body,
          ...(this.config.statusCallbackUrl ? { StatusCallback: this.config.statusCallbackUrl } : {}),
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      },
    );
    const json = (await res.json().catch(() => null)) as { sid?: unknown; code?: unknown } | null;
    if (!res.ok) {
      const error = new TwilioSendError(res.status, typeof json?.code === "number" ? json.code : null);
      throw retryableStatus(res.status) ? new TwilioRetryable(error, res.headers.get("retry-after")) : error;
    }
    return typeof json?.sid === "string" ? json.sid : undefined;
  }
}

class TwilioRetryable {
  constructor(
    readonly error: TwilioSendError,
    readonly retryAfter: string | null,
  ) {}
}

// Reads TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WEBHOOK_URL (or APP_BASE_URL + /api/sms/inbound) and
// TWILIO_STATUS_CALLBACK_URL (or APP_BASE_URL + /api/sms/status, else the same origin as the webhook URL).
// Throws with the name of the missing setting, never its value.
export function twilioConfigFromEnv(env: Record<string, string | undefined> = process.env): TwilioConfig {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  if (!accountSid || !/^AC[0-9a-fA-F]{32}$/.test(accountSid))
    throw new Error("TWILIO_ACCOUNT_SID missing or not an AC… account SID");
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  if (!authToken) throw new Error("TWILIO_AUTH_TOKEN missing");
  const base = env.APP_BASE_URL?.trim().replace(/\/+$/, "");
  const webhookUrl = env.TWILIO_WEBHOOK_URL?.trim() || (base ? `${base}/api/sms/inbound` : "");
  if (!/^https?:\/\//.test(webhookUrl) || !URL.canParse(webhookUrl))
    throw new Error("TWILIO_WEBHOOK_URL (or APP_BASE_URL) missing or not an http(s) URL");
  const statusCallbackUrl =
    env.TWILIO_STATUS_CALLBACK_URL?.trim() ||
    (base ? `${base}/api/sms/status` : new URL("/api/sms/status", webhookUrl).href);
  if (!/^https?:\/\//.test(statusCallbackUrl) || !URL.canParse(statusCallbackUrl))
    throw new Error("TWILIO_STATUS_CALLBACK_URL not an http(s) URL");
  return { accountSid, authToken, webhookUrl, statusCallbackUrl };
}
