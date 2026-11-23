// Ends the owner's session on this device.
import { inboxBaseUrl, signOut } from "../../../inbox/auth";
import { SESSION_COOKIE, clearSessionCookie, html, readCookie, sameOrigin } from "../../../inbox/http";

export async function POST(req: Request) {
  const baseUrl = inboxBaseUrl();
  if (!sameOrigin(req, baseUrl)) return html(403, "Not allowed", "<p>Please use your inbox page.</p>");
  await signOut(readCookie(req, SESSION_COOKIE));
  return html(200, "Signed out", "<p>You are signed out. Use the newest link we emailed you to sign in again.</p>", {
    "Set-Cookie": clearSessionCookie(baseUrl),
  });
}
