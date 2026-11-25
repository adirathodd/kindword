// HTTP pieces of owner accounts (SPEC FR-24): cookie, providers from env, and the server-rendered pages. Same page
// rules as the inbox (src/inbox/http.ts): no scripts, every value escaped, same-origin form posts only.
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

const err = (msg: string | null) => (msg ? `<p class="notice error" role="alert">${e(msg)}</p>` : "");
const field = (name: string, label: string, type: string, value: string, auto: string, extra = "") =>
  `<p><label for="${name}" class="stack">${e(label)}<input id="${name}" name="${name}" type="${type}" value="${e(value)}" autocomplete="${auto}" required${extra}></label></p>`;
const pw = (auto: "new-password" | "current-password") =>
  `<p><label for="password" class="stack">Password${
    auto === "new-password" ? ` <span class="meta">(at least ${MIN_PASSWORD} characters)</span>` : ""
  }<input id="password" name="password" type="password" autocomplete="${auto}" required${
    auto === "new-password" ? ` minlength="${MIN_PASSWORD}"` : ""
  } maxlength="256"></label></p>`;

export const notAllowed = () => html(403, "Not allowed", "<p>Please use the form on our site.</p>");
export const tooMany = () =>
  html(429, "Too many attempts", "<p>Too many attempts. Wait 15 minutes and try again.</p>", { "Retry-After": "900" });

export const signUpPage = (v: { name: string; businessName: string; email: string }, error: string | null = null) =>
  html(
    error ? 400 : 200,
    "Create your Kindword account",
    `${err(error)}<p>Set up review requests and owner-approved replies for your business. After you sign up, we contact you to finish setup; nothing is sent to your customers until then.</p><form method="post">${field(
      "name",
      "Your name",
      "text",
      v.name,
      "name",
      ' maxlength="200"',
    )}${field("businessName", "Business name", "text", v.businessName, "organization", ' maxlength="200"')}${field(
      "email",
      "Email",
      "email",
      v.email,
      "email",
      ' maxlength="254"',
    )}${pw("new-password")}<p><label><input type="checkbox" name="terms" value="yes" required> I agree to the <a href="/terms">terms</a> and <a href="/privacy">privacy policy</a>.</label></p><div class="row"><button type="submit" class="primary">Create account</button></div></form><p class="meta">Already have an account? <a href="/account/sign-in">Sign in</a></p>`,
  );

export const signUpClosed = () =>
  html(200, "Sign-up opens soon", "<p>We are not taking new sign-ups online yet. Email us and we will set you up.</p>");

export const checkEmailPage = (what: string) =>
  html(200, "Check your email", `<p>${e(what)}</p><p class="meta"><a href="/account/sign-in">Back to sign in</a></p>`);

export const signInPage = (email = "", error: string | null = null, status = error ? 400 : 200) =>
  html(
    status,
    "Sign in to Kindword",
    `${err(error)}<form method="post">${field("email", "Email", "email", email, "username", ' maxlength="254"')}${pw(
      "current-password",
    )}<div class="row"><button type="submit" class="primary">Sign in</button></div></form><p class="meta"><a href="/account/sign-in/link">Email me a sign-in link instead</a> · <a href="/account/reset">Forgot your password?</a> · <a href="/account/register">Create an account</a></p>`,
  );

// FR-13: the passwordless alternative to the password form.
export const signInLinkPage = (email = "", error: string | null = null) =>
  html(
    error ? 400 : 200,
    "Email me a sign-in link",
    `${err(error)}<p>Enter the email we have on file for your business. We send a link that opens your review reply inbox without a password.</p><form method="post">${field(
      "email",
      "Email",
      "email",
      email,
      "email",
      ' maxlength="254"',
    )}<div class="row"><button type="submit" class="primary">Send sign-in link</button></div></form><p class="meta"><a href="/account/sign-in">Sign in with your password</a></p>`,
  );

export const resetRequestPage = (error: string | null = null) =>
  html(
    error ? 400 : 200,
    "Reset your password",
    `${err(error)}<p>Enter your email and we will send a link to choose a new password.</p><form method="post">${field(
      "email",
      "Email",
      "email",
      "",
      "email",
      ' maxlength="254"',
    )}<div class="row"><button type="submit" class="primary">Send link</button></div></form>`,
  );

export const newPasswordPage = (error: string | null = null) =>
  html(
    error ? 400 : 200,
    "Choose a new password",
    `${err(error)}<form method="post">${pw("new-password")}<p class="meta">Choosing a new password signs you out everywhere else.</p><div class="row"><button type="submit" class="primary">Save password</button></div></form>`,
  );

export const linkInvalid = (againHtml: string) =>
  // againHtml: constant markup from our own routes
  html(400, "Link not valid", `<p>This link has expired or was already used. ${againHtml}</p>`);

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
