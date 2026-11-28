// Opens the approval inbox for one of the signed-in account's locations (SPEC FR-13, FR-24). The location must belong
// to the account's business; otherwise 404.
import { getAccountSession, openInbox } from "../../../../accounts/accounts";
import { accountSecret, notAllowed } from "../../../../accounts/http";
import { UUID_RE, inboxBaseUrl } from "../../../../inbox/auth";
import { html, redirect, sameOrigin, sessionCookie } from "../../../../inbox/http";

export async function POST(req: Request, ctx: RouteContext<"/account/inbox/[locationId]">) {
  const baseUrl = inboxBaseUrl();
  if (!sameOrigin(req, baseUrl)) return notAllowed();
  const session = await getAccountSession(accountSecret(req));
  if (!session) return redirect("/account/sign-in");
  const { locationId } = await ctx.params;
  const s = UUID_RE.test(locationId) ? await openInbox(session, locationId) : null;
  if (!s) return html(404, "Not found", "<p>That location is not on your account.</p>");
  return redirect("/inbox", { "Set-Cookie": sessionCookie(s.secret, s.expiresAt, baseUrl) });
}
