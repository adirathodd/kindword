// HTTP pieces of owner accounts (SPEC FR-24): cookie, providers from env, and the server-rendered pages. Same page
// rules as the inbox (src/inbox/http.ts): no scripts, every value escaped, same-origin form posts only.
import { after } from "next/server";
import { escapeHtml as e, inboxBaseUrl } from "../inbox/auth";
import { html, readCookie } from "../inbox/http";
import { ResendEmail, resendConfigFromEnv } from "../email/resend";
import { MIN_PASSWORD, PwnedPasswords } from "./password";
import type { Deps } from "./accounts";

export const ACCOUNT_COOKIE = "account_session";

// Real providers, built per request from env. Tests replace `make`.
export const routeDeps = {
  make(): Deps {
    return {
      email: new ResendEmail(resendConfigFromEnv()),
      breach: new PwnedPasswords(),
      baseUrl: inboxBaseUrl(),
      operatorEmail: process.env.OPERATOR_EMAIL?.trim() || undefined,
      later: (task) => after(task),
    };
  },
};

export const signupOpen = () => process.env.SIGNUP_OPEN === "true";

// Vercel sets x-real-ip / x-forwarded-for to the client address. Used only as a rate-limit key (hashed).
export const clientIp = (req: Request) =>
  req.headers.get("x-real-ip")?.trim() || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

export const accountSecret = (req: Request) => readCookie(req, ACCOUNT_COOKIE);

const secure = (baseUrl: string) => (baseUrl.startsWith("https://") ? "; Secure" : "");
export const accountCookie = (secret: string, expiresAt: Date, baseUrl: string) =>
  `${ACCOUNT_COOKIE}=${secret}; Path=/account; Expires=${expiresAt.toUTCString()}; HttpOnly; SameSite=Lax${secure(baseUrl)}`;
export const clearAccountCookie = (baseUrl: string) =>
  `${ACCOUNT_COOKIE}=; Path=/account; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secure(baseUrl)}`;

export async function formFields(req: Request) {
  const f = await req.formData().catch(() => null);
  const get = (k: string) => {
    const v = f?.get(k);
    return typeof v === "string" ? v : "";
  };
  return get;
}

// Auth pages (sign-up, sign-in, sign-in link, reset) share a narrow card layout. A field's error sits under it and is
// tied to it with aria-describedby; autofocus puts the cursor back in that field (plain HTML, no script).
const SIGN_IN: [string, string] = ["/account/sign-in", "Back to sign in"];
const page = (status: number, title: string, body: string, back = SIGN_IN) => html(status, title, body, {}, { back });

type FieldOpts = { error?: string | null; hint?: string; extra?: string; labelRow?: string };
const field = (name: string, label: string, type: string, value: string | null, auto: string, o: FieldOpts = {}) => {
  const ids = [o.hint && `${name}-hint`, o.error && `${name}-error`].filter(Boolean).join(" ");
  const lbl = `<label for="${name}">${e(label)}</label>`;
  return `<div class="field">${o.labelRow ? `<div class="label-row">${lbl}${o.labelRow}</div>` : lbl}${
    o.hint ? `<p class="hint" id="${name}-hint">${e(o.hint)}</p>` : ""
  }<input id="${name}" name="${name}" type="${type}"${value === null ? "" : ` value="${e(value)}"`} autocomplete="${auto}" required${
    o.extra ?? ""
  }${ids ? ` aria-describedby="${ids}"` : ""}${o.error ? ' aria-invalid="true" autofocus' : ""}>${
    o.error ? `<p class="field-error" id="${name}-error">${e(o.error)}</p>` : ""
  }</div>`;
};
const PW_HINT = `At least ${MIN_PASSWORD} characters. We turn down passwords found in known data breaches.`;
const newPw = (error: string | null) =>
  field("password", "Password", "password", null, "new-password", {
    error,
    hint: PW_HINT,
    extra: ` minlength="${MIN_PASSWORD}" maxlength="256"`,
  });
const alt = (links: [string, string][]) =>
  `<ul class="alt">${links.map(([href, text]) => `<li><a href="${href}">${e(text)}</a></li>`).join("")}</ul>`;

export const notAllowed = () => html(403, "Not allowed", "<p>Please use the form on our site.</p>");
export const tooMany = () =>
  html(429, "Too many attempts", "<p>Too many attempts. Wait 15 minutes and try again.</p>", { "Retry-After": "900" });

// Which sign-up field an error from signUp() belongs to; anything else shows above the form.
const signUpField = (msg: string) =>
  /password|characters/i.test(msg)
    ? "password"
    : /business name/i.test(msg)
      ? "businessName"
      : /your name/i.test(msg)
        ? "name"
        : /email/i.test(msg)
          ? "email"
          : /terms/i.test(msg)
            ? "terms"
            : "form";

export const signUpPage = (v: { name: string; businessName: string; email: string }, error: string | null = null) => {
  const on = error ? signUpField(error) : "";
  const errFor = (f: string) => (on === f ? error : null);
  const termsErr = errFor("terms");
  return page(
    error ? 400 : 200,
    "Create your Kindword account",
    `<p class="lede">Set up review requests and owner-approved replies for your business. After you sign up, we contact you to finish setup; nothing is sent to your customers until then.</p>${
      on === "form" ? `<p class="form-error" role="alert">${e(error!)}</p>` : ""
    }<form method="post">${field("name", "Your name", "text", v.name, "name", {
      error: errFor("name"),
      extra: ' maxlength="200"',
    })}${field("businessName", "Business name", "text", v.businessName, "organization", {
      error: errFor("businessName"),
      extra: ' maxlength="200"',
    })}${field("email", "Email", "email", v.email, "email", {
      error: errFor("email"),
      hint: "We send a link to this address to confirm it.",
      extra: ' maxlength="254"',
    })}${newPw(errFor("password"))}<div class="field"><label class="check"><input type="checkbox" name="terms" value="yes" required${
      termsErr ? ' aria-invalid="true" aria-describedby="terms-error" autofocus' : ""
    }> <span>I agree to the <a href="/terms">terms</a> and <a href="/privacy">privacy policy</a>.</span></label>${
      termsErr ? `<p class="field-error" id="terms-error">${e(termsErr)}</p>` : ""
    }</div><button type="submit" class="primary">Create account</button></form>`,
  );
};

export const signUpClosed = () =>
  page(200, "Sign-up opens soon", "<p>We are not taking new sign-ups online yet. Email us and we will set you up.</p>");

export const checkEmailPage = (what: string) => page(200, "Check your email", `<p class="lede">${e(what)}</p>`);

// Sign-in errors are about the pair (or the account), not one field, so they show above the form and both fields
// point at them.
export const signInPage = (email = "", error: string | null = null, status = error ? 400 : 200) => {
  const desc = error ? ' aria-describedby="form-error"' : "";
  return page(
    status,
    "Sign in to Kindword",
    `${error ? `<p class="form-error" id="form-error" role="alert">${e(error)}</p>` : ""}<form method="post">${field(
      "email",
      "Email",
      "email",
      email,
      "username",
      { extra: ` maxlength="254"${desc}` },
    )}${field("password", "Password", "password", null, "current-password", {
      extra: ` maxlength="256"${desc}`,
      labelRow: '<a href="/account/reset">Forgot your password?</a>',
    })}<button type="submit" class="primary">Sign in</button></form>${alt([
      ["/account/sign-in/link", "Email me a sign-in link instead"],
      ["/account/register", "Create an account"],
    ])}`,
    ["/", "Back to home"],
  );
};

// FR-13: the passwordless alternative to the password form.
export const signInLinkPage = (email = "", error: string | null = null) =>
  page(
    error ? 400 : 200,
    "Email me a sign-in link",
    `<p class="lede">Enter the email we have on file for your business. We send a link that opens your review reply inbox without a password.</p><form method="post">${field(
      "email",
      "Email",
      "email",
      email,
      "email",
      { error, hint: "Each link works once, for 15 minutes.", extra: ' maxlength="254"' },
    )}<button type="submit" class="primary">Send sign-in link</button></form>`,
  );

export const resetRequestPage = (error: string | null = null) =>
  page(
    error ? 400 : 200,
    "Reset your password",
    `<p class="lede">Enter your email and we will send a link to choose a new password.</p><form method="post">${field(
      "email",
      "Email",
      "email",
      "",
      "email",
      { error, extra: ' maxlength="254"' },
    )}<button type="submit" class="primary">Send reset link</button></form>${alt([
      ["/account/sign-in/link", "Email me a sign-in link instead"],
    ])}`,
  );

export const newPasswordPage = (error: string | null = null) =>
  page(
    error ? 400 : 200,
    "Choose a new password",
    `<form method="post">${newPw(error)}<button type="submit" class="primary">Save password</button><p class="note">Saving a new password signs you out everywhere else.</p></form>`,
  );

export const linkInvalid = (againHtml: string) =>
  // againHtml: constant markup from our own routes
  page(400, "Link not valid", `<p>This link has expired or was already used. ${againHtml}</p>`);

export const confirmPage = (title: string, text: string, button: string) =>
  html(
    200,
    title,
    `<p>${e(text)}</p><form method="post"><button type="submit" class="primary">${e(button)}</button></form>`,
  );

const STATUS: Record<string, string> = {
  onboarding:
    "We are setting up your account: your consent records, texting registration and Google connection. We will email you when review requests can start. Nothing is sent to your customers until then.",
  live: "Your account is live.",
  paused: "Your account is paused. No review requests are being sent.",
  offboarded: "Your account is closed.",
};

export const accountPage = (o: { businessName: string; status: string; locations: { id: string; name: string }[] }) =>
  html(
    200,
    o.businessName,
    `<p>${e(STATUS[o.status] ?? "")}</p>${
      o.locations.length
        ? `<h2>Review reply inbox</h2>${o.locations
            .map(
              (l) =>
                `<form method="post" action="/account/inbox/${e(l.id)}"><button type="submit" class="primary">Open inbox: ${e(l.name)}</button></form>`,
            )
            .join("")}`
        : ""
    }<form method="post" action="/account/sign-out"><button type="submit">Sign out</button></form>`,
  );
