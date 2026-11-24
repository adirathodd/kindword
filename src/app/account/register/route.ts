// Self-serve sign-up (SPEC FR-24, Flow 0). Closed until SIGNUP_OPEN=true (the terms and privacy pages must exist).
import { signUp } from "../../../accounts/accounts";
import {
  checkEmailPage,
  clientIp,
  formFields,
  notAllowed,
  routeDeps,
  signUpClosed,
  signUpPage,
  signupOpen,
  tooMany,
} from "../../../accounts/http";
import { inboxBaseUrl } from "../../../inbox/auth";
import { sameOrigin } from "../../../inbox/http";

export async function GET() {
  return signupOpen() ? signUpPage({ name: "", businessName: "", email: "" }) : signUpClosed();
}

export async function POST(req: Request) {
  if (!signupOpen()) return signUpClosed();
  if (!sameOrigin(req, inboxBaseUrl())) return notAllowed();
  const f = await formFields(req);
  const input = {
    name: f("name"),
    businessName: f("businessName"),
    email: f("email"),
    password: f("password"),
    terms: f("terms") === "yes",
  };
  const r = await signUp(input, clientIp(req), routeDeps.make());
  if (r.ok)
    return checkEmailPage("We sent a link to your email. Open it to confirm your address and finish signing up.");
  if ("limited" in r) return tooMany();
  return signUpPage(input, r.error);
}
