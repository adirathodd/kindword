// HTTP pieces of the owner inbox: session cookie, same-origin check and HTML pages. Pages are plain server-rendered
// HTML (like the /u unsubscribe page) with every value escaped; review text is untrusted.
import { escapeHtml as e } from "./auth";
import type { Inbox, InboxItem } from "./inbox";

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

export const html = (status: number, title: string, body: string, extra: Record<string, string> = {}) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)}</title><style>${CSS}</style></head><body><main><h1>${e(title)}</h1>${body}</main></body></html>`,
    { status, headers: { ...PAGE_HEADERS, ...extra } },
  );

export const redirect = (location: string, extra: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { "Cache-Control": "no-store", Location: location, ...extra } });

const CSS = `body{font-family:system-ui,sans-serif;margin:0;background:#f6f6f4;color:#1b1b1b;line-height:1.5}
main{max-width:44rem;margin:0 auto;padding:1.5rem 1rem 4rem}h1{font-size:1.4rem;margin:.5rem 0 1rem}
h2{font-size:1.1rem;margin:2rem 0 .75rem}article{background:#fff;border:1px solid #ddd;border-radius:8px;padding:1rem;margin:0 0 1rem}
.meta{color:#555;font-size:.9rem}.review{white-space:pre-wrap;margin:.5rem 0}.reply{white-space:pre-wrap;background:#f2f6fb;border-left:3px solid #4a78b5;padding:.5rem .75rem;margin:.5rem 0}
.flags{background:#fff4e5;border:1px solid #f0b46c;border-radius:6px;padding:.5rem .75rem;margin:.5rem 0}.badge{display:inline-block;font-size:.8rem;font-weight:600;padding:0 .4rem;border-radius:4px;background:#b3261e;color:#fff;margin-left:.4rem}
.notice{background:#e8f4ea;border:1px solid #7fbf8a;border-radius:6px;padding:.5rem .75rem}.error{background:#fdecea;border-color:#e08a83}
form{margin:.5rem 0 0}.row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}textarea{width:100%;box-sizing:border-box;min-height:6rem;font:inherit;padding:.5rem}
button{font:inherit;padding:.45rem .9rem;border-radius:6px;border:1px solid #888;background:#fff;cursor:pointer}button.primary{background:#1f5fa8;border-color:#1f5fa8;color:#fff}
details{margin-top:.5rem}summary{cursor:pointer;color:#1f5fa8}label{display:flex;gap:.4rem;align-items:flex-start}.empty{color:#555}`;

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
  const n = notice ? NOTICES[notice] : undefined;
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

export const signedOutPage = () =>
  html(
    401,
    "Sign in to see your replies",
    "<p>Your sign-in has ended. Open the newest sign-in link we emailed you, or ask us for a new one.</p>",
  );
