// Password reset link (SPEC FR-24): GET shows the form (it does not use the token), POST sets the new password,
// ends every other session and signs this device in.
import { resetPassword } from "../../../../accounts/accounts";
import {
  accountCookie,
  formFields,
  linkInvalid,
  newPasswordPage,
  notAllowed,
  routeDeps,
} from "../../../../accounts/http";
import { looksLikeSecret } from "../../../../inbox/auth";
import { redirect, sameOrigin } from "../../../../inbox/http";

const invalid = () => linkInvalid('<a href="/account/reset">Ask for a new link</a>.');

export async function GET(_req: Request, ctx: RouteContext<"/account/reset/[token]">) {
  const { token } = await ctx.params;
  return looksLikeSecret(token) ? newPasswordPage() : invalid();
}

export async function POST(req: Request, ctx: RouteContext<"/account/reset/[token]">) {
  const deps = routeDeps.make();
  if (!sameOrigin(req, deps.baseUrl)) return notAllowed();
  const { token } = await ctx.params;
  const f = await formFields(req);
  const r = await resetPassword(token, f("password"), deps);
  if (!r) return invalid();
  if (!r.ok) return newPasswordPage(r.error);
  return redirect("/account", { "Set-Cookie": accountCookie(r.secret, r.expiresAt, deps.baseUrl) });
}
