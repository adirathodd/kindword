// Repo-wide Google endpoint guard (SPEC Provider notes: Google OAuth: "one Google client module that exposes only
// list reviews and post reply; no other endpoint is called anywhere; a test fails the build if another Google method
// is called"). endpointGuard.test.ts runs it over every source file in the repo on each `npm test`, so CI's check job
// fails when a Google URL, OAuth scope, SDK package or endpoint path appears outside the allowlist below.
// businessProfile.test.ts and googleSheets.test.ts already check, at run time, which URLs each module requests; this
// guard covers the rest of the repo, where no such test exists.
//
// Allowed today:
// - src/google/businessProfile.ts (FR-11, FR-15): the OAuth token endpoint and the Business Profile v4 base, used
//   only as `${REVIEWS_API}/{location}/reviews?{query}` (list reviews) and
//   `${REVIEWS_API}/{location}/reviews/{reviewId}/reply` (post reply).
// - src/intake/googleSheets.ts (FR-2a, our own service account, not an owner's Business Profile grant): the token
//   endpoint, the read-only Sheets scope and `${SHEETS_API}/{sheetId}/values/{range}` (values.get).
// - public/landing/index.html: Google Fonts stylesheets, loaded by visitors' browsers with no credentials.
// Not allowed yet: the OAuth consent screen and token revoke (accounts.google.com, oauth2.googleapis.com/revoke). The
// Google-connect step and offboarding revoke add them here when they are built, so the change is visible in review.
//
// Pure: takes file contents, returns violations. Paths are repo-relative with forward slashes. Violations name the
// file, line and rule, and quote at most the matched Google host or identifier, never other file content.

export type SourceFile = { path: string; text: string };
export type Violation = { path: string; line: number; rule: string; detail: string };

type ModuleRule = {
  // Constants this file may declare, each as `export const NAME = "<url>";` exactly once. Only that one occurrence
  // is allowed: a second copy of the URL anywhere in the file (with another path, or inside new URL()) is reported.
  constants?: Record<string, string>;
  // Patterns that may appear in this file (for URLs whose query string may change, such as font weights).
  patterns?: RegExp[];
  // Endpoint base constants declared in this file, with the only path shapes they may be extended by. A shape is the
  // rest of a template literal that starts with `${BASE}`, with each `${...}` written as {}.
  bases?: Record<string, string[]>;
};

const TOKEN = "https://oauth2.googleapis.com/token";

export const GOOGLE_ALLOWLIST: Record<string, ModuleRule> = {
  "src/google/businessProfile.ts": {
    constants: { TOKEN_URL: TOKEN, REVIEWS_API: "https://mybusiness.googleapis.com/v4" },
    bases: { REVIEWS_API: ["/{}/reviews?{}", "/{}/reviews/{}/reply"] },
  },
  "src/intake/googleSheets.ts": {
    constants: {
      TOKEN_URL: TOKEN,
      SHEETS_API: "https://sheets.googleapis.com/v4/spreadsheets",
      SCOPE: "https://www.googleapis.com/auth/spreadsheets.readonly",
    },
    bases: { SHEETS_API: ["/{}/values/{}"] },
  },
  "public/landing/index.html": {
    patterns: [/"https:\/\/fonts\.googleapis\.com(?:\/css2\?[^"\s<>]*)?"/g],
  },
};

// Modules that hold Google endpoint constants. Nothing else may import those constants or the whole module.
const ENDPOINT_MODULES =
  /(?:^|\/)(?:google\/businessProfile|intake\/googleSheets|\.\/businessProfile|\.\/googleSheets)$/;
const ENDPOINT_NAMES = new Set(["TOKEN_URL", "REVIEWS_API", "SHEETS_API", "SCOPE"]);

// Google API client libraries. The SPEC's client is hand-written so that each call is visible; an SDK exposes every
// method of every API.
export const GOOGLE_SDK =
  /^(?:googleapis|google-auth-library|google-gax|gaxios|@googleapis\/.+|@google-cloud\/.+|@google\/.+)$/;
const SDK_SPECIFIER =
  /["'`](googleapis|google-auth-library|google-gax|gaxios|@googleapis\/[\w./-]+|@google-cloud\/[\w./-]+|@google\/[\w./-]+)["'`]/g;

// Google OAuth hosts other than the token endpoint: the consent screen, token info and revoke.
const GOOGLE_OAUTH_HOST = /\b(?:accounts|oauth2)\.google\.com\b/gi;

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;
// Blanks out an allowed span while keeping offsets and line numbers.
function blank(text: string, start: number, end: number) {
  return text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, " ") + text.slice(end);
}

function checkBases(file: SourceFile, rule: ModuleRule, out: Violation[]) {
  for (const [base, shapes] of Object.entries(rule.bases ?? {})) {
    const uses = [...file.text.matchAll(new RegExp(`\\b${base}\\b`, "g"))];
    const declarations = [...file.text.matchAll(new RegExp(`\\bexport const ${base} = "`, "g"))];
    const templates = [...file.text.matchAll(new RegExp(`\`\\$\\{${base}\\}([^\`]*)\``, "g"))];
    for (const t of templates) {
      const shape = t[1].replace(/\$\{[^}]*\}/g, "{}");
      if (!shapes.includes(shape))
        out.push({
          path: file.path,
          line: lineOf(file.text, t.index),
          rule: "google_path_not_allowed",
          detail: `${base}${shape}`,
        });
    }
    // Every other use (string concatenation, new URL(), passing the base around) could build any path.
    const other = uses.length - declarations.length - templates.length;
    if (declarations.length !== 1 || other !== 0) {
      const at = uses.find(
        (u) => !templates.some((t) => t.index + 3 === u.index) && !isDeclaration(file.text, u.index),
      );
      out.push({
        path: file.path,
        line: at ? lineOf(file.text, at.index) : 1,
        rule: "google_base_misused",
        detail: base,
      });
    }
  }
}

const isDeclaration = (text: string, index: number) => text.slice(Math.max(0, index - 13), index) === "export const ";

function checkImports(file: SourceFile, out: Violation[]) {
  if (GOOGLE_ALLOWLIST[file.path]) return; // the endpoint modules themselves
  const stmt = /\b(import|export)\s+(?:type\s+)?([^;]*?)\s+from\s*["']([^"']+)["']/g;
  for (const m of file.text.matchAll(stmt)) {
    if (!ENDPOINT_MODULES.test(m[3])) continue;
    const clause = m[2];
    const names = (clause.match(/\{([^}]*)\}/)?.[1] ?? "")
      .split(",")
      .map(
        (n) =>
          n
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/)[0],
      )
      .filter(Boolean);
    const bad = names.filter((n) => ENDPOINT_NAMES.has(n));
    if (/\*/.test(clause)) bad.push("*");
    for (const name of bad)
      out.push({ path: file.path, line: lineOf(file.text, m.index), rule: "google_endpoint_imported", detail: name });
  }
  for (const m of file.text.matchAll(/\b(?:REVIEWS_API|SHEETS_API)\b/g))
    out.push({ path: file.path, line: lineOf(file.text, m.index), rule: "google_endpoint_imported", detail: m[0] });
}

export function checkSourceFile(file: SourceFile): Violation[] {
  const out: Violation[] = [];
  const rule = GOOGLE_ALLOWLIST[file.path] ?? {};
  let text = file.text;

  for (const [name, url] of Object.entries(rule.constants ?? {})) {
    const declaration = `export const ${name} = "${url}";`;
    const at = text.indexOf(declaration);
    if (at === -1 || text.indexOf(declaration, at + 1) !== -1)
      out.push({ path: file.path, line: 1, rule: "google_allowlist_stale", detail: name });
    else text = blank(text, at, at + declaration.length);
  }
  // The token endpoint is called as is: no path, query or other URL may be built from it.
  if (rule.constants?.TOKEN_URL)
    for (const m of file.text.matchAll(
      /\$\{TOKEN_URL\}|\bTOKEN_URL\s*\+|\+\s*TOKEN_URL\b|new URL\([^)]*\bTOKEN_URL\b/g,
    ))
      out.push({ path: file.path, line: lineOf(file.text, m.index), rule: "google_base_misused", detail: "TOKEN_URL" });
  for (const pattern of rule.patterns ?? [])
    for (const m of [...text.matchAll(pattern)]) text = blank(text, m.index, m.index + m[0].length);

  for (const m of text.matchAll(/[\w.-]*googleapis(?:\.com)?/gi))
    out.push({ path: file.path, line: lineOf(text, m.index), rule: "google_api_not_allowed", detail: m[0] });
  for (const m of text.matchAll(GOOGLE_OAUTH_HOST))
    out.push({ path: file.path, line: lineOf(text, m.index), rule: "google_oauth_not_allowed", detail: m[0] });
  for (const m of file.text.matchAll(SDK_SPECIFIER))
    out.push({ path: file.path, line: lineOf(file.text, m.index), rule: "google_sdk", detail: m[1] });

  checkBases(file, rule, out);
  checkImports(file, out);
  return out;
}

// package.json: no Google SDK as a dependency of any kind. package-lock.json: none pulled in transitively either.
export function checkManifest(path: string, text: string): Violation[] {
  const out: Violation[] = [];
  const json = JSON.parse(text) as Record<string, unknown>;
  if (path.endsWith("package-lock.json")) {
    const packages = (json.packages ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(packages)) {
      const name = key.replace(/^.*node_modules\//, "");
      if (key && GOOGLE_SDK.test(name)) out.push({ path, line: 1, rule: "google_sdk", detail: name });
    }
    return out;
  }
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = (json[field] ?? {}) as Record<string, unknown>;
    for (const name of Object.keys(deps))
      if (GOOGLE_SDK.test(name)) out.push({ path, line: 1, rule: "google_sdk", detail: name });
  }
  return out;
}

export const formatViolation = (v: Violation) => `${v.path}:${v.line} ${v.rule} ${v.detail}`;
