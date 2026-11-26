// Owner approval inbox page (SPEC FR-13): every draft awaiting approval for the session's location, approved replies
// waiting to post, and replies posted in the last 30 days. The location comes only from the session cookie;
// ?location= (from owner emails) only checks it, and a mismatch gets a page to open that location instead.
import { getOwnerSession } from "../../inbox/auth";
import { listInbox } from "../../inbox/inbox";
import { SESSION_COOKIE, UUID_RE, inboxPage, otherLocationPage, readCookie, signedOutPage } from "../../inbox/http";

export async function GET(req: Request) {
  const session = await getOwnerSession(readCookie(req, SESSION_COOKIE));
  if (!session) return signedOutPage();
  const params = new URL(req.url).searchParams;
  const location = params.get("location");
  if (location && UUID_RE.test(location) && location.toLowerCase() !== session.locationId.toLowerCase())
    return otherLocationPage(location);
  const notice = params.get("done");
  return inboxPage(await listInbox(session), notice);
}
