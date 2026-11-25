// "Email me a sign-in link" (SPEC FR-13): the passwordless alternative on the owner sign-in screen. The same answer
// whether or not the email belongs to an owner; rate-limited per IP and per email.
import {
  checkEmailPage,
  clientIp,
  formFields,
  notAllowed,
  routeDeps,
  signInLinkPage,
  tooMany,
} from "../../../../accounts/http";
import { sameOrigin } from "../../../../inbox/http";
import { requestSignInLinks } from "../../../../inbox/linkRequest";

export async function GET() {
  return signInLinkPage();
}

export async function POST(req: Request) {
  const deps = routeDeps.make();
  if (!sameOrigin(req, deps.baseUrl)) return notAllowed();
  const f = await formFields(req);
  const r = await requestSignInLinks(f("email"), clientIp(req), deps);
  if (r.ok)
    return checkEmailPage(
      "If that email belongs to a Kindword owner, we sent a sign-in link for each of your locations. Each link works once, for 15 minutes.",
    );
  if ("limited" in r) return tooMany();
  return signInLinkPage(f("email"), r.error);
}
