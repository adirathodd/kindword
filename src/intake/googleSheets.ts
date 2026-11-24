// Google Sheets reader for Sheet intake (SPEC FR-2a; Integrations: Intake: CSV and Google Sheet). Implements the
// SheetReader that pollSheet uses. Reads as our own service account, which the owner adds to their sheet as a
// viewer: no OAuth to the owner's Google account, and only the read-only Sheets scope is requested.
// No SDK: a service-account token is one signed JWT exchanged at Google's token endpoint, and a read is one
// values.get call. Those two URLs are the only ones this module calls.
// Transient failures (429, 5xx, network errors, timeouts) are retried with backoff. Errors carry the HTTP status and
// a short code only, never cell values, Google's message text, the token or the private key. Safe to log.
import { createSign } from "node:crypto";
import type { SheetReader } from "./pollSheet";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
export const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
// First visible tab, columns A to Z (the template has 8 columns; the importer ignores extra ones). A range without
// a tab name refers to the first visible sheet.
export const RANGE = "A:Z";

const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;
const TOKEN_LIFETIME_S = 3600; // Google's maximum for a service-account assertion
const TOKEN_REFRESH_MARGIN_MS = 60_000;

// Spreadsheet IDs are URL-safe base64-like strings (44 characters today). Anything else never reaches Google.
const SHEET_ID_RE = /^[A-Za-z0-9_-]{20,128}$/;
const CLIENT_EMAIL_RE = /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;

export type GoogleSheetsConfig = {
  clientEmail: string; // the service account, e.g. intake@project.iam.gserviceaccount.com
  privateKey: string; // PEM ("-----BEGIN PRIVATE KEY-----"), from the service account's JSON key
};

export type GoogleSheetsOptions = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  maxAttempts?: number;
};

// code: invalid_sheet_id (refused before any call), no_access (sheet not shared with the service account, or
// deleted: 403 or 404), auth_failed (Google refused our key: fix the configuration), bad_response, timeout, network,
// http_error. retryable is true for failures a later run may get past without anyone acting.
export class GoogleSheetsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`Google Sheets read failed: status=${status} code=${code}`);
    this.name = "GoogleSheetsError";
  }
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const retryableStatus = (status: number) => status === 429 || status >= 500;

function delayFor(attempt: number, retryAfter: string | null) {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(ms, MAX_DELAY_MS);
}

// The signed assertion for the JWT bearer grant (RFC 7523), RS256 with the service account's key.
export function serviceAccountAssertion(config: GoogleSheetsConfig, now: Date) {
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: config.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + TOKEN_LIFETIME_S }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(config.privateKey);
  return `${header}.${claims}.${b64url(signature)}`;
}

export class GoogleSheetsReader implements SheetReader {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: GoogleSheetsConfig,
    opts: GoogleSheetsOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => new Date());
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? MAX_ATTEMPTS);
  }

  // Header row first, then data rows, each a list of cell strings as the sheet displays them (so a date cell reads
  // as the owner typed it). Trailing empty cells and rows are omitted by the API; an empty sheet gives [].
  async readRows(sheetId: string): Promise<string[][]> {
    if (!SHEET_ID_RE.test(sheetId)) throw new GoogleSheetsError(0, "invalid_sheet_id", false);
    const url =
      `${SHEETS_API}/${sheetId}/values/${encodeURIComponent(RANGE)}` +
      "?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE";
    let res = await this.call(url, async () => ({ Authorization: `Bearer ${await this.accessToken()}` }));
    if (res.status === 401) {
      // The cached token was revoked or expired early: get a new one and try once more.
      this.token = null;
      res = await this.call(url, async () => ({ Authorization: `Bearer ${await this.accessToken()}` }));
    }
    if (res.status === 401) throw new GoogleSheetsError(401, "auth_failed", false);
    if (res.status === 403 || res.status === 404) throw new GoogleSheetsError(res.status, "no_access", false);
    if (!res.ok) throw new GoogleSheetsError(res.status, "http_error", retryableStatus(res.status));
    const json = (await res.json().catch(() => null)) as { values?: unknown } | null;
    if (!json || typeof json !== "object") throw new GoogleSheetsError(res.status, "bad_response", true);
    if (json.values === undefined) return [];
    if (!Array.isArray(json.values) || !json.values.every(Array.isArray))
      throw new GoogleSheetsError(res.status, "bad_response", true);
    return (json.values as unknown[][]).map((row) => row.map((cell) => (cell == null ? "" : String(cell))));
  }

  private async accessToken(): Promise<string> {
    const now = this.now().getTime();
    if (this.token && this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) return this.token.value;
    let assertion: string;
    try {
      assertion = serviceAccountAssertion(this.config, this.now());
    } catch {
      throw new GoogleSheetsError(0, "auth_failed", false); // the private key does not parse
    }
    const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
    const res = await this.call(TOKEN_URL, async () => ({ "Content-Type": "application/x-www-form-urlencoded" }), {
      method: "POST",
      body: body.toString(),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403)
      throw new GoogleSheetsError(res.status, "auth_failed", false);
    if (!res.ok) throw new GoogleSheetsError(res.status, "http_error", retryableStatus(res.status));
    const json = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (typeof json?.access_token !== "string" || !json.access_token)
      throw new GoogleSheetsError(res.status, "bad_response", true);
    const ttlS = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : TOKEN_LIFETIME_S;
    this.token = { value: json.access_token, expiresAt: now + ttlS * 1000 };
    return this.token.value;
  }

  // One request with retries on 429, 5xx, network errors and timeouts. Returns the last response (ok or a
  // non-retryable status) or throws when every attempt failed without a usable response.
  private async call(
    url: string,
    headers: () => Promise<Record<string, string>>,
    init: { method?: string; body?: string } = {},
  ): Promise<Response> {
    let last: GoogleSheetsError = new GoogleSheetsError(0, "network", true);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: init.method ?? "GET",
          headers: { Accept: "application/json", ...(await headers()) },
          body: init.body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        if (e instanceof GoogleSheetsError) throw e; // from getting a token for this call
        last = new GoogleSheetsError(0, e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network", true);
        if (attempt < this.maxAttempts) await this.sleep(delayFor(attempt, null));
        continue;
      }
      if (!retryableStatus(res.status)) return res;
      last = new GoogleSheetsError(res.status, "http_error", true);
      if (attempt < this.maxAttempts) await this.sleep(delayFor(attempt, res.headers.get("retry-after")));
    }
    throw last;
  }
}

// Reads GOOGLE_SHEETS_CLIENT_EMAIL and GOOGLE_SHEETS_PRIVATE_KEY (the service account's client_email and
// private_key from its JSON key file; "\n" escapes in the key are accepted, as hosts often store one-line values).
// Throws with the name of the missing setting, never its value.
export function googleSheetsConfigFromEnv(env: Record<string, string | undefined> = process.env): GoogleSheetsConfig {
  const clientEmail = env.GOOGLE_SHEETS_CLIENT_EMAIL?.trim().toLowerCase();
  if (!clientEmail || !CLIENT_EMAIL_RE.test(clientEmail))
    throw new Error("GOOGLE_SHEETS_CLIENT_EMAIL missing or not a service-account address");
  const privateKey = env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!privateKey || !/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----$/.test(privateKey))
    throw new Error("GOOGLE_SHEETS_PRIVATE_KEY missing or not a PEM private key");
  return { clientEmail, privateKey: `${privateKey}\n` };
}
