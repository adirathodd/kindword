// Sign-in link (SPEC FR-13). GET only shows a button, so email link scanners that fetch URLs cannot use up the
// single-use token; POST uses it, sets the 30-day session cookie and opens the inbox.
import { inboxBaseUrl, looksLikeSecret, redeemSignInToken } from "../../../../inbox/auth";
import { html, redirect, sameOrigin, sessionCookie } from "../../../../inbox/http";

const invalid = () =>
  html(
    400,
    "Link not valid",
    '<p>This sign-in link has expired or was already used. Open the newest link we emailed you, or <a href="/account/sign-in/link">get a new link</a>.</p>',
  );

export async function GET(_req: Request, ctx: RouteContext<"/inbox/sign-in/[token]">) {
  const { token } = await ctx.params;
  if (!looksLikeSecret(token)) return invalid();
  return html(
    200,
    "Sign in",
    `<p>Open your review reply inbox. You will stay signed in on this device for 30 days.</p><form method="post"><button type="submit" class="primary">Sign in</button></form>`,
  );
}

export async function POST(req: Request, ctx: RouteContext<"/inbox/sign-in/[token]">) {
  const baseUrl = inboxBaseUrl();
  if (!sameOrigin(req, baseUrl)) return html(403, "Not allowed", "<p>Please use the link from your email.</p>");
  const { token } = await ctx.params;
  const result = await redeemSignInToken(token);
  if (!result) return invalid();
  return redirect("/inbox", { "Set-Cookie": sessionCookie(result.secret, result.expiresAt, baseUrl) });
}
