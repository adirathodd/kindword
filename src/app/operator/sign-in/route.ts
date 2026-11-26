// Operator sign-in: email, password and an authenticator code (SPEC Security). The same message for any wrong part.
import { clientIp } from "../../../accounts/http";
import { inboxBaseUrl } from "../../../inbox/auth";
import { redirect, sameOrigin } from "../../../inbox/http";
import { operatorSignIn } from "../../../operator/auth";
import { formFields, notAllowed, operatorConfig, operatorCookie, signInPage } from "../../../operator/http";

export async function GET() {
  return signInPage({ disabled: !operatorConfig() });
}

export async function POST(req: Request) {
  const config = operatorConfig();
  if (!config) return signInPage({ disabled: true });
  const baseUrl = inboxBaseUrl();
  if (!sameOrigin(req, baseUrl)) return notAllowed();
  const f = await formFields(req);
  const r = await operatorSignIn(
    { email: f.get("email"), password: f.get("password"), code: f.get("code") },
    clientIp(req),
    { config },
  );
  if (r.ok) return redirect("/operator", { "Set-Cookie": operatorCookie(r.secret, r.expiresAt, baseUrl) });
  if (r.reason === "limited")
    return signInPage({ email: f.get("email"), error: "Too many attempts. Try again in 15 minutes.", status: 429 });
  return signInPage({
    email: f.get("email"),
    error: "That email, password and code do not match. Codes work once.",
    status: 401,
  });
}
