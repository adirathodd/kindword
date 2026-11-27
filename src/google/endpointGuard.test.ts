// SPEC Provider notes (Google OAuth): "a test fails the build if another Google method is called". The first block
// runs the guard over the whole repo; the rest prove the guard catches each way a new Google call could be added.
// No network. Fixture strings only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkManifest, checkSourceFile, formatViolation, type Violation } from "./endpointGuard";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".claude", ".vercel", "coverage", "design"]);
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|html|json)$/;
// Test files hold fake URLs on purpose; the runtime tests next to each client check what it really requests.
const TEST_FILE = /\.test\.(?:ts|tsx|mts|js|mjs)$/;

function sourceFiles(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) sourceFiles(full, out);
    } else if (SOURCE.test(name) && !TEST_FILE.test(name) && name !== "package-lock.json") out.push(full);
  }
  return out;
}

const rel = (full: string) => relative(ROOT, full).split(sep).join("/");
const repoPath = (p: string) => join(ROOT, p);
const GUARD = "src/google/endpointGuard.ts";

describe("the repo calls no Google endpoint outside the allowlist", () => {
  it("finds no Google API host, OAuth host, SDK or endpoint path outside the allowed modules", () => {
    const files = sourceFiles(ROOT);
    expect(files.map(rel)).toEqual(expect.arrayContaining(["src/google/businessProfile.ts", "src/jobs/jobs.ts"]));
    const violations = files
      .filter((f) => rel(f) !== GUARD) // the rules themselves; checked below to call and import nothing
      .flatMap((f) => checkSourceFile({ path: rel(f), text: readFileSync(f, "utf8") }));
    expect(violations.map(formatViolation)).toEqual([]);
  });

  it("the guard module, which names the allowed hosts, makes no calls and imports nothing", () => {
    const guard = readFileSync(repoPath(GUARD), "utf8");
    expect(guard).not.toMatch(/\bfetch\s*\(|^\s*import\s|\bimport\s*\(|\brequire\s*\(/m);
  });

  it("has no Google SDK in package.json or package-lock.json", () => {
    for (const p of ["package.json", "package-lock.json"])
      expect(checkManifest(p, readFileSync(repoPath(p), "utf8")).map(formatViolation)).toEqual([]);
  });

  it("still allows exactly the endpoints the clients use (guards against a stale allowlist)", () => {
    const bp = readFileSync(repoPath("src/google/businessProfile.ts"), "utf8");
    expect(bp).toContain('export const TOKEN_URL = "https://oauth2.googleapis.com/token";');
    expect(bp).toContain('export const REVIEWS_API = "https://mybusiness.googleapis.com/v4";');
    const sheets = readFileSync(repoPath("src/intake/googleSheets.ts"), "utf8");
    expect(sheets).toContain('export const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";');
    expect(sheets).toContain('export const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";');
  });
});

const BP = "src/google/businessProfile.ts";
const SHEETS = "src/intake/googleSheets.ts";
const rules = (vs: Violation[]) => vs.map((v) => `${v.rule} ${v.detail}`);

const bpModule = (extra = "") => `
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVIEWS_API = "https://mybusiness.googleapis.com/v4";
const list = \`\${REVIEWS_API}/\${location.googleLocationId}/reviews?\${q}\`;
const reply = \`\${REVIEWS_API}/\${location.googleLocationId}/reviews/\${reviewId}/reply\`;
${extra}`;

describe("checkSourceFile", () => {
  it("allows the Business Profile module's token endpoint, list reviews and post reply", () => {
    expect(checkSourceFile({ path: BP, text: bpModule() })).toEqual([]);
  });

  it("allows the Sheets reader's token endpoint, read-only scope and values.get", () => {
    const text = `
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
export const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const url = \`\${SHEETS_API}/\${sheetId}/values/\${encodeURIComponent(RANGE)}\` + "?majorDimension=ROWS";`;
    expect(checkSourceFile({ path: SHEETS, text })).toEqual([]);
  });

  it("rejects another Business Profile method built on the allowed base", () => {
    const vs = checkSourceFile({
      path: BP,
      text: bpModule("const loc = `${REVIEWS_API}/${location.googleLocationId}`;"),
    });
    expect(rules(vs)).toEqual(["google_path_not_allowed REVIEWS_API/{}"]);
    expect(vs[0].line).toBe(6);
  });

  it("rejects deleting a reply (same path as post reply, different suffix)", () => {
    const vs = checkSourceFile({
      path: BP,
      text: bpModule("const d = `${REVIEWS_API}/${l}/reviews/${r}/reply:delete`;"),
    });
    expect(rules(vs)).toEqual(["google_path_not_allowed REVIEWS_API/{}/reviews/{}/reply:delete"]);
  });

  it("rejects the base used any way other than a checked template literal", () => {
    for (const extra of [
      'const u = REVIEWS_API + "/accounts";',
      "const u = new URL(REVIEWS_API);",
      "send(REVIEWS_API);",
      "const u = `x${REVIEWS_API}/a`;",
    ])
      expect(rules(checkSourceFile({ path: BP, text: bpModule(extra) }))).toEqual(["google_base_misused REVIEWS_API"]);
  });

  it("rejects a changed base URL in the allowed module", () => {
    const text = bpModule().replace("mybusiness.googleapis.com/v4", "mybusinessaccountmanagement.googleapis.com/v1");
    expect(rules(checkSourceFile({ path: BP, text }))).toContain(
      "google_api_not_allowed mybusinessaccountmanagement.googleapis.com",
    );
  });

  it("rejects a Google API host in any other module, however it is written", () => {
    for (const text of [
      'await fetch("https://mybusinessbusinessinformation.googleapis.com/v1/locations/1");',
      "const u = `https://oauth2.googleapis.com/revoke?token=${t}`;",
      'const host = "googleapis" + ".com";',
      "// call https://www.googleapis.com/oauth2/v3/tokeninfo",
    ])
      expect(checkSourceFile({ path: "src/reviews/new.ts", text }).map((v) => v.rule)).toContain(
        "google_api_not_allowed",
      );
  });

  it("rejects the allowed token URL outside the two client modules", () => {
    const vs = checkSourceFile({ path: "src/jobs/jobs.ts", text: 'const t = "https://oauth2.googleapis.com/token";' });
    expect(rules(vs)).toEqual(["google_api_not_allowed oauth2.googleapis.com"]);
  });

  it("rejects the OAuth consent and revoke hosts until the connect step adds them", () => {
    for (const text of [
      'redirect("https://accounts.google.com/o/oauth2/v2/auth?scope=x");',
      'fetch("https://oauth2.google.com/revoke");',
    ])
      expect(checkSourceFile({ path: "src/app/connect/route.ts", text }).map((v) => v.rule)).toEqual([
        "google_oauth_not_allowed",
      ]);
  });

  it("rejects Google SDK imports, requires and dynamic imports", () => {
    for (const [text, sdk] of [
      ['import { google } from "googleapis";', "googleapis"],
      ["import { OAuth2Client } from 'google-auth-library';", "google-auth-library"],
      ['const m = await import("@googleapis/mybusinessaccountmanagement");', "@googleapis/mybusinessaccountmanagement"],
      ['const s = require("@google-cloud/storage");', "@google-cloud/storage"],
    ])
      expect(rules(checkSourceFile({ path: "src/x.ts", text }))).toContain(`google_sdk ${sdk}`);
  });

  it("rejects importing the endpoint constants or the whole client module elsewhere", () => {
    for (const [text, name] of [
      ['import { REVIEWS_API } from "../google/businessProfile";', "REVIEWS_API"],
      ['import { TOKEN_URL as T, BusinessProfileClient } from "@/google/businessProfile";', "TOKEN_URL"],
      ['import { SCOPE } from "../intake/googleSheets";', "SCOPE"],
      ['import * as bp from "./businessProfile";', "*"],
      ['export { SHEETS_API } from "./googleSheets";', "SHEETS_API"],
    ])
      expect(rules(checkSourceFile({ path: "src/google/other.ts", text }))).toContain(
        `google_endpoint_imported ${name}`,
      );
  });

  it("allows importing the clients themselves and types", () => {
    const text = `import { BusinessProfileClient, googleOAuthConfigFromEnv } from "../google/businessProfile";
import { GoogleReviewsError, type GoogleReview, type ReviewSource } from "../google/businessProfile";
import { GoogleSheetsReader } from "../intake/googleSheets";`;
    expect(checkSourceFile({ path: "src/jobs/jobs.ts", text })).toEqual([]);
  });

  it("allows Google review links and Maps, which are pages for customers, not API calls", () => {
    const text =
      'const ok = ["https://search.google.com/local/writereview?placeid=x", "https://www.google.com/maps/x"];';
    expect(checkSourceFile({ path: "src/app/operator/locations.ts", text })).toEqual([]);
  });

  it("allows Google Fonts on the landing page only", () => {
    const html = `<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Host+Grotesk:wght@400..700&display=swap" rel="stylesheet" />`;
    expect(checkSourceFile({ path: "public/landing/index.html", text: html })).toEqual([]);
    expect(checkSourceFile({ path: "src/inbox/http.ts", text: html }).map((v) => v.rule)).toEqual([
      "google_api_not_allowed",
      "google_api_not_allowed",
    ]);
  });

  it("reports the line of each violation and no other file content", () => {
    const vs = checkSourceFile({
      path: "src/a.ts",
      text: 'const secret = "s3cr3t";\nfetch("https://x.googleapis.com/y");',
    });
    expect(vs).toEqual([{ path: "src/a.ts", line: 2, rule: "google_api_not_allowed", detail: "x.googleapis.com" }]);
    expect(formatViolation(vs[0])).not.toContain("s3cr3t");
  });
});

describe("checkManifest", () => {
  it("rejects a Google SDK in any dependency field", () => {
    const pkg = JSON.stringify({
      dependencies: { next: "16", googleapis: "1" },
      devDependencies: { "@google-cloud/local-auth": "1" },
    });
    expect(rules(checkManifest("package.json", pkg))).toEqual([
      "google_sdk googleapis",
      "google_sdk @google-cloud/local-auth",
    ]);
  });

  it("rejects a Google SDK pulled in transitively through the lockfile", () => {
    const lock = JSON.stringify({
      packages: { "": {}, "node_modules/next": {}, "node_modules/foo/node_modules/google-auth-library": {} },
    });
    expect(rules(checkManifest("package-lock.json", lock))).toEqual(["google_sdk google-auth-library"]);
  });

  it("accepts the current kind of dependencies", () => {
    const pkg = JSON.stringify({ dependencies: { "@anthropic-ai/sdk": "1", "@vercel/queue": "0", zod: "4" } });
    expect(checkManifest("package.json", pkg)).toEqual([]);
  });
});
