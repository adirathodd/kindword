// Email verification link (SPEC FR-24). GET only shows a button, so link scanners cannot use up the single-use
// token; POST confirms the email and signs the owner in.
import { verifyEmail } from "../../../../accounts/accounts";
import { accountCookie, confirmPage, linkInvalid, notAllowed } from "../../../../accounts/http";
import { inboxBaseUrl, looksLikeSecret } from "../../../../inbox/auth";
import { redirect, sameOrigin } from "../../../../inbox/http";

const invalid = () => linkInvalid('Sign in to get a new one: <a href="/account/sign-in">sign in</a>.');

export async function GET(_req: Request, ctx: RouteContext<"/account/verify/[token]">) {
  const { token } = await ctx.params;
  if (!looksLikeSecret(token)) return invalid();
  return confirmPage(
    "Confirm your email",
    "Confirm your email address to finish creating your account.",
    "Confirm email",
  );
}

export async function POST(req: Request, ctx: RouteContext<"/account/verify/[token]">) {
  const baseUrl = inboxBaseUrl();
  if (!sameOrigin(req, baseUrl)) return notAllowed();
  const { token } = await ctx.params;
  const s = await verifyEmail(token);
  if (!s) return invalid();
  return redirect("/account", { "Set-Cookie": accountCookie(s.secret, s.expiresAt, baseUrl) });
}
