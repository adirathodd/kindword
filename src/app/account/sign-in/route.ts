// Owner sign-in with email and password (SPEC FR-24). The same message for an unknown email and a wrong password.
import { signIn } from "../../../accounts/accounts";
import {
  accountCookie,
  clientIp,
  formFields,
  notAllowed,
  routeDeps,
  signInPage,
  tooMany,
} from "../../../accounts/http";
import { inboxBaseUrl } from "../../../inbox/auth";
import { redirect, sameOrigin } from "../../../inbox/http";

export async function GET() {
  return signInPage();
}

export async function POST(req: Request) {
  const deps = routeDeps.make();
  if (!sameOrigin(req, deps.baseUrl)) return notAllowed();
  const f = await formFields(req);
  const r = await signIn({ email: f("email"), password: f("password") }, clientIp(req), deps);
  if (r.ok) return redirect("/account", { "Set-Cookie": accountCookie(r.secret, r.expiresAt, inboxBaseUrl()) });
  if (r.reason === "limited") return tooMany();
  if (r.reason === "unverified")
    return signInPage(f("email"), "Confirm your email first. We sent you a new link; it works for 24 hours.", 403);
  return signInPage(f("email"), "That email and password do not match an account.", 401);
}
