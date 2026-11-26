// Resend adapter for the email provider boundary (SPEC FR-6, FR-13; Integrations: Email (Resend)). No SDK: sending is
// one REST call. Sends from one verified address (a subdomain set up with SPF, DKIM and DMARC); the display name
// comes from each message.
// Transient failures (429, 5xx, network errors, timeouts) are retried with backoff under one Idempotency-Key, so a
// retry after a lost response cannot send the same email twice. A Retry-After longer than MAX_DELAY_MS is not slept
// through or cut short: the send stops and the error carries retryAfterMs so the caller can defer (F-12-3). Nothing here logs or returns the recipient, the
// subject, the body or the API key.
import { randomUUID } from "node:crypto";
import type { EmailMessage, EmailProvider } from "./provider";

const API_URL = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000; // a longer Retry-After is not waited out here: the error carries it to the caller
const MAX_IDEMPOTENCY_KEY = 256;

// One address, no display name, no list. Deliberately strict: anything else is refused before it reaches Resend.
const EMAIL_RE =
  /^[^\s@<>,;:"()[\]\\]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
const hasLineBreak = (s: string) => /[\r\n]/.test(s);

export type ResendConfig = {
  apiKey: string;
  fromAddress: string; // e.g. requests@mail.example.com, on a domain verified in Resend
};

export type ResendOptions = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
};

// Raised when Resend refuses a message, or a message is refused before sending. Carries the HTTP status (0 when no
// response arrived) and Resend's error name (e.g. validation_error) only, never Resend's message text, which can
// echo the recipient. Safe to log.
export class ResendSendError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null, // Resend's Retry-After, when it sent one
  ) {
    super(`Resend send failed: status=${status} code=${code ?? "none"}`);
    this.name = "ResendSendError";
  }

  // Definitely not sent: refused before sending, a non-retryable 4xx, or a 429. A timeout, lost connection, 409
  // (same key still in flight) or 5xx may have been accepted, so it is not a refusal (FR-9 counts it as asked).
  get refused() {
    return !this.retryable || this.status === 429;
  }
}

// Display names go inside a quoted string. Quotes, backslashes, angle brackets and line breaks are dropped so a
// business name cannot change the address or add a header.
export function formatFrom(fromName: string, fromAddress: string) {
  const name = fromName
    .replace(/[\r\n"\\<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return name ? `"${name}" <${fromAddress}>` : fromAddress;
}

function validate(m: EmailMessage) {
  const refuse = (code: string) => new ResendSendError(0, code, false);
  if (!EMAIL_RE.test(m.to) || m.to.length > 254) return refuse("invalid_recipient");
  if (!m.subject.trim() || hasLineBreak(m.subject)) return refuse("invalid_subject");
  if (!m.text && !m.html) return refuse("empty_body");
  for (const [k, v] of Object.entries(m.headers)) {
    if (!HEADER_NAME_RE.test(k) || hasLineBreak(v)) return refuse("invalid_header");
  }
  if (m.idempotencyKey !== undefined && (!m.idempotencyKey || m.idempotencyKey.length > MAX_IDEMPOTENCY_KEY))
    return refuse("invalid_idempotency_key");
  return null;
}

const retryableStatus = (status: number) => status === 429 || status === 409 || status >= 500;

// Retry-After in seconds (Resend sends seconds on 429).
function retryAfterMs(header: string | null) {
  const seconds = header === null ? NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}
const backoff = (attempt: number) => BASE_DELAY_MS * 2 ** (attempt - 1);

export class ResendEmail implements EmailProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;

  constructor(
    private readonly config: ResendConfig,
    opts: ResendOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? MAX_ATTEMPTS);
  }

  async send(message: EmailMessage): Promise<string | void> {
    const invalid = validate(message);
    if (invalid) throw invalid;
    // One key for every attempt of this send: Resend returns the first result for a repeated key instead of sending
    // again. Callers pass a stable key (e.g. the review request ID) so a later job retry is covered too.
    const idempotencyKey = message.idempotencyKey ?? randomUUID();
    const body = JSON.stringify({
      from: formatFrom(message.fromName, this.config.fromAddress),
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
      ...(Object.keys(message.headers).length ? { headers: message.headers } : {}),
    });

    let last: ResendSendError = new ResendSendError(0, "not_sent", true);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (e) {
        // Network error or timeout: the email may or may not have been accepted; the same key makes a retry safe.
        last = new ResendSendError(0, e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network", true);
        if (attempt < this.maxAttempts) await this.sleep(backoff(attempt));
        continue;
      }
      const json = (await res.json().catch(() => null)) as { id?: unknown; name?: unknown } | null;
      if (res.ok) return typeof json?.id === "string" ? json.id : undefined;
      const code = typeof json?.name === "string" && /^[a-z_]{1,64}$/.test(json.name) ? json.name : null;
      const wait = retryAfterMs(res.headers.get("retry-after"));
      last = new ResendSendError(res.status, code, retryableStatus(res.status), wait);
      if (!last.retryable || (wait !== null && wait > MAX_DELAY_MS)) throw last;
      if (attempt < this.maxAttempts) await this.sleep(wait ?? backoff(attempt));
    }
    throw last;
  }
}

// Reads RESEND_API_KEY and EMAIL_FROM_ADDRESS. Throws with the name of the missing setting, never its value.
export function resendConfigFromEnv(env: Record<string, string | undefined> = process.env): ResendConfig {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey || !/^re_[A-Za-z0-9_]+$/.test(apiKey)) throw new Error("RESEND_API_KEY missing or not a re_… API key");
  const fromAddress = env.EMAIL_FROM_ADDRESS?.trim().toLowerCase();
  if (!fromAddress || !EMAIL_RE.test(fromAddress))
    throw new Error("EMAIL_FROM_ADDRESS missing or not a plain email address");
  return { apiKey, fromAddress };
}
