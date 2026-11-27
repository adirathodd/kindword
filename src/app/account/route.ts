// Owner entry URL (SPEC FR-13, D-2) and account home (FR-24). A signed-in owner with one location goes straight to its
// inbox; otherwise the account page shows business status and a button per location to open its approval inbox.
import { accountOverview, getAccountSession, openInbox } from "../../accounts/accounts";
import { accountPage, accountSecret } from "../../accounts/http";
import { inboxBaseUrl } from "../../inbox/auth";
import { redirect, sessionCookie } from "../../inbox/http";

// This GET opens an inbox session, so only for a real navigation the owner made on our site or by typing/bookmarking
// the URL: never cross-site (CSRF), never a prefetch, and never a browser that sends no fetch metadata. Anything else
// gets the account page, whose button POSTs to /account/inbox/<id> as before.
function ownNavigation(req: Request) {
  const h = req.headers;
  const site = h.get("sec-fetch-site");
  if (site !== "same-origin" && site !== "none") return false;
  if (h.get("sec-fetch-mode") !== "navigate") return false;
  return !/prefetch|prerender/i.test(`${h.get("sec-purpose") ?? ""} ${h.get("purpose") ?? ""}`);
}

export async function GET(req: Request) {
  const session = await getAccountSession(accountSecret(req));
  if (!session) return redirect("/account/sign-in");
  const overview = await accountOverview(session);
  if (overview.locations.length === 1 && ownNavigation(req)) {
    const s = await openInbox(session, overview.locations[0].id);
    if (s) return redirect("/inbox", { "Set-Cookie": sessionCookie(s.secret, s.expiresAt, inboxBaseUrl()) });
  }
  return accountPage(overview);
}
