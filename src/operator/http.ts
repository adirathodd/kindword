// HTTP pieces of the operator area (SPEC FR-1, Security): session cookie, form parsing, the guard every operator
// route uses, and the server-rendered pages. Same page rules as the inbox (src/inbox/http.ts): no scripts, every value
// escaped, same-origin form posts only. The cookie is SameSite=Strict and sent only to /operator.
import { escapeHtml as e, inboxBaseUrl } from "../inbox/auth";
import { html, readCookie, redirect, sameOrigin } from "../inbox/http";
import { getOperatorSession, operatorConfigFromEnv, type OperatorSession } from "./auth";
import { LANGUAGES, VERTICALS, type BusinessInput, type Fields, type LocationInput } from "./businesses";

export const OPERATOR_COOKIE = "operator_session";
const secure = (baseUrl: string) => (baseUrl.startsWith("https://") ? "; Secure" : "");
export const operatorCookie = (secret: string, expiresAt: Date, baseUrl: string) =>
  `${OPERATOR_COOKIE}=${secret}; Path=/operator; Expires=${expiresAt.toUTCString()}; HttpOnly; SameSite=Strict${secure(baseUrl)}`;
export const clearOperatorCookie = (baseUrl: string) =>
  `${OPERATOR_COOKIE}=; Path=/operator; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict${secure(baseUrl)}`;
export const operatorSecret = (req: Request) => readCookie(req, OPERATOR_COOKIE);

// The env-configured operator, or null (sign-in is off). The missing setting's name is never shown to visitors.
export const operatorConfig = () => {
  const r = operatorConfigFromEnv();
  return r.ok ? r.config : null;
};

export async function formFields(req: Request): Promise<Fields> {
  const f = await req.formData().catch(() => null);
  const str = (v: FormDataEntryValue) => (typeof v === "string" ? v.slice(0, 5000) : "");
  return {
    get: (k) => {
      const v = f?.get(k);
      return v == null ? "" : str(v);
    },
    all: (k) => (f?.getAll(k) ?? []).map(str),
  };
}

export const notAllowed = () => html(403, "Not allowed", "<p>Please use the form on our site.</p>");
export const notFound = () => html(404, "Not found", '<p><a href="/operator">Back to businesses</a></p>');

// Every operator page and form goes through this: a valid operator session, and for posts, a same-origin request.
export async function requireOperator(
  req: Request,
  run: (session: OperatorSession) => Promise<Response>,
): Promise<Response> {
  if (req.method !== "GET" && !sameOrigin(req, inboxBaseUrl())) return notAllowed();
  const session = await getOperatorSession(operatorSecret(req));
  if (!session) return redirect("/operator/sign-in");
  return run(session);
}

// ---- pages ----------------------------------------------------------------------------------------------------

const err = (msg: string | null | undefined) => (msg ? `<p class="notice error" role="alert">${e(msg)}</p>` : "");
const fieldErr = (msg: string | undefined) => (msg ? `<span class="meta" role="alert">${e(msg)}</span>` : "");
const input = (name: string, label: string, value: string, extra = "", error?: string) =>
  `<p><label class="stack">${e(label)}<input type="text" name="${name}" value="${e(value)}"${extra}>${fieldErr(error)}</label></p>`;
const area = (name: string, label: string, value: string, hint: string, error?: string) =>
  `<p><label class="stack">${e(label)}<span class="meta">${e(hint)}</span><textarea name="${name}">${e(value)}</textarea>${fieldErr(error)}</label></p>`;
const nav = `<p class="meta"><a href="/operator">Businesses</a></p>`;
const signOut = `<form method="post" action="/operator/sign-out"><button type="submit">Sign out</button></form>`;

export const signInPage = (
  opts: { error?: string | null; email?: string; status?: number; disabled?: boolean } = {},
) =>
  opts.disabled
    ? html(503, "Operator sign-in is not set up", "<p>Operator sign-in is off until it is set up.</p>")
    : html(
        opts.status ?? (opts.error ? 400 : 200),
        "Operator sign-in",
        `${err(opts.error)}<form method="post" action="/operator/sign-in">${input(
          "email",
          "Email",
          opts.email ?? "",
          ' autocomplete="username" maxlength="254"',
        )}<p><label class="stack">Password<input type="password" name="password" autocomplete="current-password" maxlength="1024" required></label></p>${input(
          "code",
          "Code from your authenticator app",
          "",
          ' inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required',
        )}<div class="row"><button type="submit" class="primary">Sign in</button></div></form>`,
      );

const STATUS: Record<string, string> = {
  onboarding: "Onboarding",
  live: "Live",
  paused: "Paused",
  offboarded: "Offboarded",
};
const verticalLabel = (id: string) => VERTICALS.find((v) => v.id === id)?.label ?? id;

export const businessListPage = (
  rows: { id: string; name: string; vertical: string; status: string; locations: number }[],
) =>
  html(
    200,
    "Businesses",
    `<p><a href="/operator/businesses/new">Add a business</a></p>${
      rows.length
        ? rows
            .map(
              (b) =>
                `<article><a href="/operator/businesses/${e(b.id)}"><strong>${e(b.name)}</strong></a><p class="meta">${e(
                  STATUS[b.status] ?? b.status,
                )} · ${e(verticalLabel(b.vertical))} · ${b.locations === 1 ? "1 location" : `${b.locations} locations`}${
                  b.locations === 0 ? " (add one to finish setup)" : ""
                }</p></article>`,
            )
            .join("")
        : '<p class="empty">No businesses yet.</p>'
    }${signOut}`,
  );

type BizValues = { name: string; vertical: string; languages: string[]; toneNotes: string; approvedFacts: string };
type LocValues = { name: string; reviewLink: string; timezone: string };
type Errors<T> = Partial<Record<keyof T, string>>;

export const bizValues = (b?: Partial<BusinessInput> | null, f?: Fields): BizValues =>
  f
    ? {
        name: f.get("name"),
        vertical: f.get("vertical"),
        languages: f.all("languages"),
        toneNotes: f.get("toneNotes"),
        approvedFacts: f.get("approvedFacts"),
      }
    : {
        name: b?.name ?? "",
        vertical: b?.vertical ?? "",
        languages: b?.languages ?? ["en"],
        toneNotes: b?.toneNotes ?? "",
        approvedFacts: b?.approvedFacts ?? "",
      };
export const locValues = (l?: Partial<LocationInput> | null, f?: Fields): LocValues =>
  f
    ? { name: f.get("name"), reviewLink: f.get("reviewLink"), timezone: f.get("timezone") }
    : { name: l?.name ?? "", reviewLink: l?.reviewLink ?? "", timezone: l?.timezone ?? "America/New_York" };

function businessFields(v: BizValues, errors: Errors<BusinessInput> = {}) {
  const options = VERTICALS.map(
    (x) => `<option value="${x.id}"${x.id === v.vertical ? " selected" : ""}>${e(x.label)}</option>`,
  ).join("");
  const langs = LANGUAGES.map(
    (l) =>
      `<label><input type="checkbox" name="languages" value="${l.id}"${v.languages.includes(l.id) ? " checked" : ""}> ${e(l.label)}</label>`,
  ).join("");
  return `${input("name", "Business name", v.name, ' maxlength="120" required', errors.name)}<p><label class="stack">Type of home service<select name="vertical" required><option value="">Choose…</option>${options}</select>${fieldErr(
    errors.vertical,
  )}</label></p><fieldset><legend>Languages for requests and replies</legend>${langs}${fieldErr(errors.languages)}</fieldset>${area(
    "toneNotes",
    "Tone notes",
    v.toneNotes,
    "Formal or casual, words to avoid. The reply drafter follows these.",
    errors.toneNotes,
  )}${area(
    "approvedFacts",
    "Approved facts",
    v.approvedFacts,
    "The only business facts a reply may use, such as hours or the phone or email for taking a complaint offline.",
    errors.approvedFacts,
  )}`;
}

function locationFields(v: LocValues, errors: Errors<LocationInput> = {}, prefix = "") {
  return `${input(`${prefix}name`, "Location name", v.name, ' maxlength="120" required', errors.name)}${input(
    `${prefix}reviewLink`,
    "Google review link",
    v.reviewLink,
    ' inputmode="url" maxlength="500" required placeholder="https://g.page/r/.../review"',
    errors.reviewLink,
  )}${input(`${prefix}timezone`, "Time zone (IANA)", v.timezone, ' maxlength="64" required', errors.timezone)}`;
}

export const newBusinessPage = (
  biz: BizValues,
  loc: LocValues,
  errors: { business?: Errors<BusinessInput>; location?: Errors<LocationInput> } = {},
) =>
  html(
    errors.business || errors.location ? 400 : 200,
    "Add a business",
    `${nav}${errors.business || errors.location ? err("Fix the fields marked below.") : ""}<form method="post" action="/operator/businesses/new">${businessFields(
      biz,
      errors.business,
    )}<h2>First location</h2>${locationFields(loc, errors.location, "location.")}<div class="row"><button type="submit" class="primary">Add business</button></div></form>`,
  );

export const businessPage = (
  b: {
    id: string;
    status: string;
    locations: { id: string; name: string; reviewLink: string; timezone: string }[];
  },
  biz: BizValues,
  opts: {
    notice?: string | null;
    businessErrors?: Errors<BusinessInput>;
    newLocation?: LocValues;
    newLocationErrors?: Errors<LocationInput>;
    editing?: { id: string; values: LocValues; errors: Errors<LocationInput> };
  } = {},
) => {
  const hasErrors = !!(opts.businessErrors || opts.newLocationErrors || opts.editing);
  const locs = b.locations
    .map((l) => {
      const editing = opts.editing?.id === l.id ? opts.editing : null;
      return `<article><form method="post" action="/operator/businesses/${e(b.id)}/locations/${e(l.id)}">${locationFields(
        editing?.values ?? locValues(l),
        editing?.errors,
      )}<div class="row"><button type="submit">Save location</button></div></form></article>`;
    })
    .join("");
  return html(
    hasErrors ? 400 : 200,
    biz.name || "Business",
    `${nav}${opts.notice ? `<p class="notice" role="status">${e(opts.notice)}</p>` : ""}${
      hasErrors ? err("Fix the fields marked below.") : ""
    }<p class="meta">Status: ${e(STATUS[b.status] ?? b.status)}</p><form method="post" action="/operator/businesses/${e(
      b.id,
    )}">${businessFields(biz, opts.businessErrors)}<div class="row"><button type="submit" class="primary">Save business</button></div></form><h2>Locations</h2>${
      locs || '<p class="empty">No locations yet. Add one to finish setup.</p>'
    }<h2>Add a location</h2><form method="post" action="/operator/businesses/${e(b.id)}/locations">${locationFields(
      opts.newLocation ?? locValues(),
      opts.newLocationErrors,
    )}<div class="row"><button type="submit">Add location</button></div></form>`,
  );
};
