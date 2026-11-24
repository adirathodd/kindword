// Ends the owner's account session on this device.
import { signOutAccount } from "../../../accounts/accounts";
import { accountSecret, clearAccountCookie, notAllowed } from "../../../accounts/http";
import { inboxBaseUrl } from "../../../inbox/auth";
import { redirect, sameOrigin } from "../../../inbox/http";

export async function POST(req: Request) {
  const baseUrl = inboxBaseUrl();
  if (!sameOrigin(req, baseUrl)) return notAllowed();
  await signOutAccount(accountSecret(req));
  return redirect("/account/sign-in", { "Set-Cookie": clearAccountCookie(baseUrl) });
}
