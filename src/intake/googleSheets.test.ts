// Fake fetch only: no call reaches Google. The key pair is generated per run and never leaves the test.
import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  googleSheetsConfigFromEnv,
  GoogleSheetsError,
  GoogleSheetsReader,
  SCOPE,
  serviceAccountAssertion,
  SHEETS_API,
  TOKEN_URL,
} from "./googleSheets";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const config = { clientEmail: "intake@kindword-test.iam.gserviceaccount.com", privateKey };
const SHEET = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
const NOW = new Date("2026-11-24T15:00:00Z");

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

// Scripted fake: token requests and values requests each take the next response from their own queue.
function fake(script: { token?: (Response | Error)[]; values?: (Response | Error)[] }) {
  const calls: Call[] = [];
  const token = [...(script.token ?? [])];
  const values = [...(script.values ?? [])];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    });
    const queue = url === TOKEN_URL ? token : url.startsWith(`${SHEETS_API}/`) ? values : null;
    if (!queue) throw new Error(`unexpected URL ${url}`);
    const next = queue.shift() ?? (url === TOKEN_URL ? json(200, { access_token: "tok", expires_in: 3600 }) : null);
    if (!next) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const sleeps: number[] = [];
const reader = (f: ReturnType<typeof fake>, now = () => NOW) =>
  new GoogleSheetsReader(config, { fetchImpl: f.fetchImpl, sleep: async (ms) => void sleeps.push(ms), now });
const ROWS = [
  ["row_id", "name", "phone", "email", "visit_time", "consent_method", "consent_date", "evidence_ref"],
  ["1", "Pat Doe", "201-555-0100", "pat@example.test", "11/20/2026 14:30", "signed estimate", "2026-11-01", "e1"],
  ["2", "Lee Poe", "", "lee@example.test", "11/21/2026 9:00"],
];

describe("serviceAccountAssertion", () => {
  it("is an RS256 JWT for the read-only Sheets scope, signed with the service account's key", () => {
    const jwt = serviceAccountAssertion(config, NOW);
    const [h, c, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const iat = NOW.getTime() / 1000;
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({
      iss: config.clientEmail,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    });
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
  });
});

describe("GoogleSheetsReader", () => {
  it("gets a token, then reads the first tab as displayed values, header row first", async () => {
    const f = fake({ values: [json(200, { range: "Sheet1!A1:Z3", majorDimension: "ROWS", values: ROWS })] });
    expect(await reader(f).readRows(SHEET)).toEqual(ROWS);

    expect(f.calls).toHaveLength(2);
    const [tok, read] = f.calls;
    expect(tok).toMatchObject({ url: TOKEN_URL, method: "POST" });
    const form = new URLSearchParams(tok.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const claims = JSON.parse(Buffer.from(form.get("assertion")!.split(".")[1], "base64url").toString());
    expect(claims.scope).toBe(SCOPE);
    expect(read.url).toBe(`${SHEETS_API}/${SHEET}/values/A%3AZ?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
    expect(read).toMatchObject({ method: "GET", headers: { Authorization: "Bearer tok" } });
  });

  it("only ever calls the token endpoint and values.get (read only)", async () => {
    const f = fake({ values: [json(200, { values: ROWS }), json(200, { values: ROWS })] });
    const r = reader(f);
    await r.readRows(SHEET);
    await r.readRows(SHEET);
    for (const c of f.calls) {
      expect(c.url === TOKEN_URL || c.url.startsWith(`${SHEETS_API}/${SHEET}/values/`)).toBe(true);
      if (c.url !== TOKEN_URL) expect(c.method).toBe("GET");
    }
  });

  it("returns [] for an empty sheet (the API omits values)", async () => {
    const f = fake({ values: [json(200, { range: "Sheet1!A1:Z1000", majorDimension: "ROWS" })] });
    expect(await reader(f).readRows(SHEET)).toEqual([]);
  });

  it("turns any non-string cell into a string and a null cell into an empty one", async () => {
    const f = fake({
      values: [
        json(200, {
          values: [
            ["row_id", "name"],
            [7, null],
            [true, "x"],
          ],
        }),
      ],
    });
    expect(await reader(f).readRows(SHEET)).toEqual([
      ["row_id", "name"],
      ["7", ""],
      ["true", "x"],
    ]);
  });

  it("reuses the token until a minute before it expires, then gets a new one", async () => {
    let now = NOW;
    const f = fake({
      token: [
        json(200, { access_token: "one", expires_in: 3600 }),
        json(200, { access_token: "two", expires_in: 3600 }),
      ],
      values: [json(200, { values: ROWS }), json(200, { values: ROWS }), json(200, { values: ROWS })],
    });
    const r = reader(f, () => now);
    await r.readRows(SHEET);
    now = new Date(NOW.getTime() + 58 * 60_000);
    await r.readRows(SHEET);
    now = new Date(NOW.getTime() + 59 * 60_000 + 1);
    await r.readRows(SHEET);
    const auth = f.calls.filter((c) => c.url !== TOKEN_URL).map((c) => c.headers.Authorization);
    expect(auth).toEqual(["Bearer one", "Bearer one", "Bearer two"]);
    expect(f.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
  });

  it("gets a fresh token once when Google answers 401, and gives up with auth_failed on a second 401", async () => {
    const ok = fake({
      token: [json(200, { access_token: "old" }), json(200, { access_token: "new" })],
      values: [json(401, {}), json(200, { values: ROWS })],
    });
    expect(await reader(ok).readRows(SHEET)).toEqual(ROWS);
    expect(ok.calls.filter((c) => c.url !== TOKEN_URL).map((c) => c.headers.Authorization)).toEqual([
      "Bearer old",
      "Bearer new",
    ]);

    const bad = fake({ values: [json(401, {}), json(401, {})] });
    await expect(reader(bad).readRows(SHEET)).rejects.toMatchObject({ status: 401, code: "auth_failed" });
  });

  it("retries 429, 5xx and network errors with backoff, honoring Retry-After", async () => {
    sleeps.length = 0;
    const f = fake({
      values: [json(429, {}, { "Retry-After": "2" }), new TypeError("fetch failed"), json(200, { values: ROWS })],
    });
    expect(await reader(f).readRows(SHEET)).toEqual(ROWS);
    expect(sleeps).toEqual([2000, 1000]);
  });

  it("stops after 3 attempts with a retryable error", async () => {
    const f = fake({ values: [json(503, {}), json(503, {}), json(503, {})] });
    const e = await reader(f)
      .readRows(SHEET)
      .catch((e) => e);
    expect(e).toBeInstanceOf(GoogleSheetsError);
    expect(e).toMatchObject({ status: 503, code: "http_error", retryable: true });
    expect(f.calls.filter((c) => c.url !== TOKEN_URL)).toHaveLength(3);
  });

  it("reports a timeout as retryable", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const f = fake({ values: [timeout, timeout, timeout] });
    await expect(reader(f).readRows(SHEET)).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("reports a sheet that is not shared with the service account (403) or is gone (404) as no_access", async () => {
    for (const status of [403, 404]) {
      const f = fake({ values: [json(status, { error: { message: "secret detail" } })] });
      const e = await reader(f)
        .readRows(SHEET)
        .catch((e) => e);
      expect(e).toMatchObject({ status, code: "no_access", retryable: false });
      expect(String(e.message)).not.toContain("secret detail");
      expect(f.calls.filter((c) => c.url !== TOKEN_URL)).toHaveLength(1); // not retried
    }
  });

  it("reports a refused key at the token endpoint as auth_failed without retrying", async () => {
    const f = fake({ token: [json(400, { error: "invalid_grant" })] });
    await expect(reader(f).readRows(SHEET)).rejects.toMatchObject({ status: 400, code: "auth_failed" });
    expect(f.calls).toHaveLength(1);
  });

  it("reports a private key that does not parse as auth_failed before calling Google", async () => {
    const f = fake({});
    const r = new GoogleSheetsReader({ ...config, privateKey: "not a key" }, { fetchImpl: f.fetchImpl });
    await expect(r.readRows(SHEET)).rejects.toMatchObject({ code: "auth_failed" });
    expect(f.calls).toHaveLength(0);
  });

  it("refuses a malformed sheet ID before calling Google", async () => {
    const f = fake({});
    for (const id of ["", "short", "../../drive/v3/files", `${SHEET}/values/A1?x=`, "a".repeat(129)])
      await expect(reader(f).readRows(id)).rejects.toMatchObject({ code: "invalid_sheet_id" });
    expect(f.calls).toHaveLength(0);
  });

  it("reports an unexpected body as bad_response", async () => {
    for (const body of [{ values: "nope" }, { values: [["a"], "b"] }]) {
      const f = fake({ values: [json(200, body)] });
      await expect(reader(f).readRows(SHEET)).rejects.toMatchObject({ code: "bad_response" });
    }
  });

  it("never puts the token or the private key in an error", async () => {
    const f = fake({
      token: [json(200, { access_token: "very-secret-token" })],
      values: [json(500, {}), json(500, {}), json(500, {})],
    });
    const e = await reader(f)
      .readRows(SHEET)
      .catch((e) => e);
    expect(JSON.stringify({ ...e, message: e.message })).not.toMatch(/very-secret-token|PRIVATE KEY/);
  });
});

describe("googleSheetsConfigFromEnv", () => {
  const oneLine = privateKey.trim().replace(/\n/g, "\\n");

  it("reads the service account and accepts a one-line key with \\n escapes", () => {
    const c = googleSheetsConfigFromEnv({
      GOOGLE_SHEETS_CLIENT_EMAIL: " Intake@Kindword-Test.iam.gserviceaccount.com ",
      GOOGLE_SHEETS_PRIVATE_KEY: oneLine,
    });
    expect(c.clientEmail).toBe("intake@kindword-test.iam.gserviceaccount.com");
    expect(c.privateKey).toBe(privateKey);
    expect(() => serviceAccountAssertion(c, NOW)).not.toThrow();
  });

  it("accepts a key with Windows line endings, real or escaped, and signs as with the plain key (O-41-2)", () => {
    const plain = googleSheetsConfigFromEnv({
      GOOGLE_SHEETS_CLIENT_EMAIL: config.clientEmail,
      GOOGLE_SHEETS_PRIVATE_KEY: privateKey,
    });
    const crlfKeys = [
      privateKey.replace(/\n/g, "\r\n"), // multi-line value pasted from a file saved on Windows
      privateKey.trim().replace(/\n/g, "\\r\\n"), // one-line value with escaped CRLF
      `${privateKey.trim().replace(/\n/g, "\r\n")}\r\n`, // trailing CRLF
    ];
    for (const key of crlfKeys) {
      const c = googleSheetsConfigFromEnv({
        GOOGLE_SHEETS_CLIENT_EMAIL: config.clientEmail,
        GOOGLE_SHEETS_PRIVATE_KEY: key,
      });
      expect(c.privateKey).toBe(privateKey);
      expect(c.privateKey).not.toContain("\r");
      expect(serviceAccountAssertion(c, NOW)).toBe(serviceAccountAssertion(plain, NOW));
    }
  });

  it("still refuses a CRLF value that is not a PEM private key, without echoing it", () => {
    for (const key of ["hunter2\r\n", "-----BEGIN PUBLIC KEY-----\r\nAAAA\r\n-----END PUBLIC KEY-----\r\n"]) {
      let err: Error | undefined;
      try {
        googleSheetsConfigFromEnv({ GOOGLE_SHEETS_CLIENT_EMAIL: config.clientEmail, GOOGLE_SHEETS_PRIVATE_KEY: key });
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).toBe("GOOGLE_SHEETS_PRIVATE_KEY missing or not a PEM private key");
    }
  });

  it("names the missing or malformed setting without echoing its value", () => {
    expect(() => googleSheetsConfigFromEnv({ GOOGLE_SHEETS_PRIVATE_KEY: oneLine })).toThrow(
      "GOOGLE_SHEETS_CLIENT_EMAIL",
    );
    expect(() =>
      googleSheetsConfigFromEnv({ GOOGLE_SHEETS_CLIENT_EMAIL: "owner@gmail.com", GOOGLE_SHEETS_PRIVATE_KEY: oneLine }),
    ).toThrow("GOOGLE_SHEETS_CLIENT_EMAIL");
    const e = (() => {
      try {
        googleSheetsConfigFromEnv({
          GOOGLE_SHEETS_CLIENT_EMAIL: config.clientEmail,
          GOOGLE_SHEETS_PRIVATE_KEY: "hunter2",
        });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(e?.message).toContain("GOOGLE_SHEETS_PRIVATE_KEY");
    expect(e?.message).not.toContain("hunter2");
  });
});
