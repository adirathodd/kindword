// Asks for a password reset link (SPEC FR-24). Same answer whether or not the email has an account.
import { requestReset } from "../../../accounts/accounts";
import {
  checkEmailPage,
  clientIp,
  formFields,
  notAllowed,
  resetRequestPage,
  routeDeps,
  tooMany,
} from "../../../accounts/http";
import { sameOrigin } from "../../../inbox/http";

export async function GET() {
  return resetRequestPage();
}

export async function POST(req: Request) {
  const deps = routeDeps.make();
  if (!sameOrigin(req, deps.baseUrl)) return notAllowed();
  const f = await formFields(req);
  if (!f("email").trim()) return resetRequestPage("Enter your email.");
  const r = await requestReset(f("email"), clientIp(req), deps);
  if (!r.ok) return tooMany();
  return checkEmailPage(
    "If that email has an account, we sent a link to choose a new password. It works for 15 minutes.",
  );
}
