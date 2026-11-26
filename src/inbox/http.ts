// HTTP pieces of the owner inbox: session cookie, same-origin check and HTML pages. Pages are plain server-rendered
// HTML (like the /u unsubscribe page) with every value escaped; review text is untrusted.
import { escapeHtml as e } from "./auth";
import type { Inbox, InboxItem } from "./inbox";
import { BRAND_CSS_VARS } from "../ui/brand";

export const SESSION_COOKIE = "owner_session";

export const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  // same-origin, not no-referrer: with no-referrer browsers send "Origin: null" on form posts, which the same-origin
  // check must refuse. Our URLs (including the sign-in token) still never leak to another site.
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  // No scripts at all; forms only post back to us; never framed (approve buttons must not be clickjacked).
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

export function readCookie(req: Request, name: string) {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

const secure = (baseUrl: string) => (baseUrl.startsWith("https://") ? "; Secure" : "");

export const sessionCookie = (secret: string, expiresAt: Date, baseUrl: string) =>
  `${SESSION_COOKIE}=${secret}; Path=/inbox; Expires=${expiresAt.toUTCString()}; HttpOnly; SameSite=Lax${secure(baseUrl)}`;

export const clearSessionCookie = (baseUrl: string) =>
  `${SESSION_COOKIE}=; Path=/inbox; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secure(baseUrl)}`;

// Form posts must come from our own pages. SameSite=Lax already keeps the cookie off cross-site posts; this also
// refuses them outright (and covers the sign-in form, which has no cookie yet).
export function sameOrigin(req: Request, baseUrl: string) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false; // cross-site or a sibling subdomain
  const origin = req.headers.get("origin");
  return !origin || origin === new URL(baseUrl).origin; // "null" (opaque origin) never matches
}

// auth: the sign-up, sign-in and reset pages, a narrow card under the wordmark with a back link (href, text) on top.
export const html = (
  status: number,
  title: string,
  body: string,
  extra: Record<string, string> = {},
  auth?: { back: [string, string] },
) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)}</title><style>${CSS}</style></head>${
      auth
        ? `<body class="auth"><main><a class="wordmark" href="/">Kindword</a><div class="panel"><a class="back" href="${e(auth.back[0])}"><span aria-hidden="true">&larr; </span>${e(auth.back[1])}</a><h1>${e(title)}</h1>${body}</div></main></body>`
        : `<body><main><h1>${e(title)}</h1>${body}</main></body>`
    }</html>`,
    { status, headers: { ...PAGE_HEADERS, ...extra } },
  );

export const redirect = (location: string, extra: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { "Cache-Control": "no-store", Location: location, ...extra } });

// The auth layout (sign-up, sign-in, sign-in link, reset). Field borders use muted, not line, so they reach 3:1.
const AUTH_CSS = `body.auth main{max-width:26rem;padding:2.5rem 1rem 4rem}
.wordmark{display:inline-block;font-size:1.25rem;font-weight:500;letter-spacing:-0.03em;text-decoration:none;margin:0 0 1.25rem}
.panel{background:var(--k-card);border:1px solid var(--k-line);border-radius:var(--k-radius-lg);padding:1.75rem 1.5rem}
.back{display:inline-block;font-size:.9375rem;margin:0 0 1rem}.panel a{text-decoration-thickness:1px;text-underline-offset:.2em}
.back,.label-row a,.alt a{font-weight:500;text-decoration:none}.back:hover,.label-row a:hover{color:var(--k-muted)}
body.auth h1{font-size:1.75rem;line-height:1.2;letter-spacing:-0.03em;margin:0 0 .5rem}.lede{margin:0 0 1.5rem}
.panel form{margin:1.5rem 0 0}.field{margin:0 0 1.25rem}.field>label,.label-row>label{display:block;font-weight:500;margin:0 0 .25rem}
.label-row{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;column-gap:1rem}.label-row a{font-size:.9375rem}
.hint{color:var(--k-muted);font-size:.875rem;margin:0 0 .5rem}
body.auth input[type=text],body.auth input[type=email],body.auth input[type=password]{max-width:none;min-height:2.75rem;padding:.5rem .75rem;border-color:var(--k-muted)}
body.auth [aria-invalid=true]{border-color:var(--k-error-line);box-shadow:inset 0 0 0 1px var(--k-error-line)}
.field-error,.form-error{background:var(--k-error-bg);border:1px solid var(--k-error-line);border-radius:var(--k-radius-md);padding:.5rem .75rem;margin:.5rem 0 0;font-size:.9375rem}.form-error{margin:1rem 0 0}
.field>.check{display:flex;gap:.625rem;align-items:flex-start;font-weight:400}.check input{appearance:none;display:grid;place-content:center;width:1.25rem;height:1.25rem;margin:.15rem 0 0;flex:none;border:1px solid var(--k-muted);border-radius:var(--k-radius-sm);background:var(--k-card);cursor:pointer}.check input::before{content:"";width:.3rem;height:.6rem;border:solid var(--k-ink-on);border-width:0 2px 2px 0;transform:translateY(-1px) rotate(45deg);visibility:hidden}.check input:checked{background:var(--k-ink);border-color:var(--k-ink)}.check input:checked::before{visibility:visible}
body.auth button.primary{width:100%;min-height:2.75rem;margin-top:.25rem}.note{color:var(--k-muted);font-size:.875rem;margin:.75rem 0 0}
.alt{list-style:none;display:grid;gap:.5rem;padding:1.5rem 0 0;margin:1.5rem 0 0;border-top:1px solid var(--k-line)}
.alt a{display:flex;align-items:center;justify-content:center;min-height:2.75rem;box-sizing:border-box;padding:.5rem 1rem;text-align:center;background:var(--k-surface);border:1px solid var(--k-line);border-radius:var(--k-radius-md)}.alt a:hover{border-color:var(--k-muted)}
@media (max-width:30rem){body.auth main{padding-top:1.5rem}.panel{padding:1.5rem 1.25rem}}`;

// Brand tokens as CSS variables (src/ui/brand.ts, docs/BRAND.md); no web fonts here: the CSP allows none.
const CSS = `${BRAND_CSS_VARS}
body{font-family:var(--k-font);margin:0;background:var(--k-bg);color:var(--k-ink);line-height:1.5}
main{max-width:44rem;margin:0 auto;padding:1.5rem 1rem 4rem}h1{font-size:1.5rem;font-weight:500;letter-spacing:-0.02em;margin:.5rem 0 1rem}
h2{font-size:1.1rem;font-weight:500;margin:2rem 0 .75rem}article{background:var(--k-card);border:1px solid var(--k-line);border-radius:var(--k-radius-lg);padding:1rem;margin:0 0 1rem}
.meta{color:var(--k-muted);font-size:.9rem}.review{white-space:pre-wrap;margin:.5rem 0}.reply{white-space:pre-wrap;background:var(--k-surface);border-left:3px solid var(--k-ink);padding:.5rem .75rem;margin:.5rem 0}
.flags{background:var(--k-warn-bg);border:1px solid var(--k-warn-line);border-radius:var(--k-radius-md);padding:.5rem .75rem;margin:.5rem 0}.badge{display:inline-block;font-size:.8rem;font-weight:500;padding:0 .4rem;border-radius:var(--k-radius-sm);background:var(--k-alert);color:#fff;margin-left:.4rem}
.notice{background:var(--k-ok-bg);border:1px solid var(--k-ok-line);border-radius:var(--k-radius-md);padding:.5rem .75rem}.error{background:var(--k-error-bg);border-color:var(--k-error-line)}
form{margin:.5rem 0 0}.row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}textarea{width:100%;box-sizing:border-box;min-height:6rem;font:inherit;color:inherit;padding:.5rem;border:1px solid var(--k-line);border-radius:var(--k-radius-md);background:var(--k-card)}
button{font:inherit;font-weight:500;padding:.5rem 1rem;border-radius:var(--k-radius-md);border:1px solid var(--k-line);background:var(--k-surface);color:var(--k-ink);cursor:pointer}button.primary{background:var(--k-ink);border-color:var(--k-ink);color:var(--k-ink-on)}
:focus-visible{outline:2px solid var(--k-ink);outline-offset:2px}
details{margin-top:.5rem}summary{cursor:pointer;color:var(--k-ink);font-weight:500}label{display:flex;gap:.4rem;align-items:flex-start}.empty{color:var(--k-muted)}
label.stack{flex-direction:column;gap:.25rem}input[type=text],input[type=email],input[type=password],input[type=tel]{font:inherit;color:inherit;padding:.45rem .6rem;border:1px solid var(--k-line);border-radius:var(--k-radius-md);background:var(--k-card);width:100%;max-width:24rem;box-sizing:border-box}a{color:var(--k-ink)}
${AUTH_CSS}`;

const FLAG_LABELS: Record<string, string> = {
  low_rating: "Rating of 2 stars or lower",
  personal_details: "Names, phone numbers or other personal details",
  injury: "Mentions an injury",
  property_damage: "Mentions property damage",
  safety: "Mentions a safety problem",
  insurance: "Mentions an insurance claim",
  legal: "Mentions legal action",
  discrimination: "Mentions discrimination",
  health: "Mentions health",
  threat: "Threatens to post elsewhere",
  profanity: "Profanity",
  spam: "Looks fake or spam",
  post_check_failed: "Draft failed the automatic check (length, link or contact details)",
  risk_check_failed: "The automatic risk check could not run; read the review carefully",
};
const flagLabel = (f: string) => FLAG_LABELS[f] ?? f.replace(/_/g, " ");

const stars = (n: number) => `${"★".repeat(n)}${"☆".repeat(5 - n)}`;
const date = (d: Date | null) =>
  d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";

function reviewBlock(i: InboxItem) {
  return `<p class="meta"><span aria-label="${i.rating} out of 5 stars">${stars(i.rating)}</span> · ${e(i.reviewerName ?? "A customer")}${i.reviewPostedAt ? ` · ${date(i.reviewPostedAt)}` : ""}</p>${
    i.reviewText ? `<p class="review">${e(i.reviewText)}</p>` : `<p class="review empty">(Rating only, no text)</p>`
  }`;
}

function pendingCard(i: InboxItem) {
  const action = `/inbox/drafts/${i.draftId}`;
  const held = i.status === "held";
  const flags = held
    ? `<div class="flags"><strong>Needs extra care.</strong> Read the review and the reply before approving.${
        i.flags.length ? `<ul>${i.flags.map((f) => `<li>${e(flagLabel(f))}</li>`).join("")}</ul>` : ""
      }</div>`
    : "";
  const approve = held
    ? `<form method="post" action="${action}"><input type="hidden" name="action" value="approve_anyway"><label><input type="checkbox" name="confirm" value="yes" required> I have read this reply and want it posted as written.</label><div class="row"><button type="submit" class="primary">Approve anyway</button></div></form>`
    : `<form method="post" action="${action}"><input type="hidden" name="action" value="approve"><button type="submit" class="primary">Approve</button></form>`;
  return `<article id="d-${i.draftId}">${reviewBlock(i)}${flags}<p class="meta">Suggested reply${
    i.overdue ? `<span class="badge">Overdue</span>` : ""
  }</p><div class="reply">${e(i.draftText)}</div>${approve}<details${held ? " open" : ""}><summary>Edit the reply</summary><form method="post" action="${action}"><input type="hidden" name="action" value="edit"><label for="t-${i.draftId}" class="meta">Your reply (posted as written once you save)</label><textarea id="t-${i.draftId}" name="text" required maxlength="4000">${e(i.draftText)}</textarea><div class="row"><button type="submit" class="primary">Save and approve</button></div></form></details><form method="post" action="${action}"><input type="hidden" name="action" value="reject"><button type="submit">Reject (never post)</button></form></article>`;
}

const doneCard = (i: InboxItem, when: string) =>
  `<article>${reviewBlock(i)}<p class="meta">${when}</p><div class="reply">${e(i.finalText ?? i.draftText)}</div></article>`;

const NOTICES: Record<string, [string, boolean]> = {
  approved: ["Reply approved. It will be posted to Google.", false],
  rejected: ["Draft rejected. It will not be posted.", false],
  not_allowed: ["That draft was already handled.", true],
  not_found: ["That draft is no longer in your inbox.", true],
  needs_confirmation: ["Tick the box to confirm before approving a flagged reply.", true],
  empty_text: ["The reply cannot be empty.", true],
  too_long: ["The reply is too long (4,000 characters at most).", true],
};

export function inboxPage(inbox: Inbox, notice: string | null) {
  const n = notice && Object.hasOwn(NOTICES, notice) ? NOTICES[notice] : undefined; // not inherited keys (?done=constructor)
  const pending = inbox.pending.length
    ? inbox.pending.map(pendingCard).join("")
    : `<p class="empty">No replies waiting for you. We will email you when a new one is ready.</p>`;
  const approved = inbox.approved.length
    ? `<h2>Approved, waiting to post (${inbox.approved.length})</h2>${inbox.approved
        .map((i) => doneCard(i, `Approved ${date(i.approvedAt)}`))
        .join("")}`
    : "";
  const posted = inbox.posted.length
    ? inbox.posted.map((i) => doneCard(i, `Posted ${date(i.postedAt)}`)).join("")
    : `<p class="empty">No replies posted in the last 30 days.</p>`;
  return html(
    200,
    "Review replies",
    `${n ? `<p class="notice${n[1] ? " error" : ""}" role="status">${e(n[0])}</p>` : ""}<h2>Waiting for you (${inbox.pending.length})</h2>${pending}${approved}<h2>Posted in the last 30 days</h2>${posted}<form method="post" action="/inbox/sign-out"><button type="submit">Sign out</button></form>`,
  );
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// An owner email named a location the session does not cover (audit F-40-1). Shows nothing about either location:
// the account route checks the location belongs to the signed-in business before opening its inbox.
export const otherLocationPage = (locationId: string) =>
  html(
    200,
    "This email is for another location",
    `<p>You are signed in to the reply inbox of a different location.</p><form method="post" action="/account/inbox/${e(locationId)}"><button type="submit" class="primary">Open this location's inbox</button></form><p>This needs you to be signed in to your account. <a href="/account/sign-in">Sign in to your account</a>, or <a href="/inbox">go back to the inbox you are signed in to</a>.</p>`,
  );

export const signedOutPage = () =>
  html(
    401,
    "Sign in to see your replies",
    '<p>Your sign-in has ended. <a href="/account/sign-in">Sign in to your account</a>, or <a href="/account/sign-in/link">get a sign-in link by email</a>.</p>',
  );
