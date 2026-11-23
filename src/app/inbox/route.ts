// Owner approval inbox page (SPEC FR-13): every draft awaiting approval for the session's location, approved replies
// waiting to post, and replies posted in the last 30 days. The location comes only from the session cookie.
import { getOwnerSession } from "../../inbox/auth";
import { listInbox } from "../../inbox/inbox";
import { SESSION_COOKIE, inboxPage, readCookie, signedOutPage } from "../../inbox/http";

export async function GET(req: Request) {
  const session = await getOwnerSession(readCookie(req, SESSION_COOKIE));
  if (!session) return signedOutPage();
  const notice = new URL(req.url).searchParams.get("done");
  return inboxPage(await listInbox(session), notice);
}
