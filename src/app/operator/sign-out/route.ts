// Ends the operator session.
import { inboxBaseUrl } from "../../../inbox/auth";
import { redirect, sameOrigin } from "../../../inbox/http";
import { operatorSignOut } from "../../../operator/auth";
import { clearOperatorCookie, notAllowed, operatorSecret } from "../../../operator/http";

export async function POST(req: Request) {
  const baseUrl = inboxBaseUrl();
  if (!sameOrigin(req, baseUrl)) return notAllowed();
  await operatorSignOut(operatorSecret(req));
  return redirect("/operator/sign-in", { "Set-Cookie": clearOperatorCookie(baseUrl) });
}
