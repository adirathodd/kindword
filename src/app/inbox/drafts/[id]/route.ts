// Owner decision on one draft (SPEC FR-14): approve, approve anyway (flagged), edit and approve, or reject. The draft
// must belong to the session's location; the location never comes from the request.
import { getOwnerSession, inboxBaseUrl } from "../../../../inbox/auth";
import { decide, type Decision } from "../../../../inbox/inbox";
import { SESSION_COOKIE, html, readCookie, redirect, sameOrigin, signedOutPage } from "../../../../inbox/http";

function parse(form: FormData): Decision | null {
  switch (form.get("action")) {
    case "approve":
      return { action: "approve" };
    case "approve_anyway":
      return { action: "approve_anyway", confirmed: form.get("confirm") === "yes" };
    case "edit": {
      const text = form.get("text");
      return typeof text === "string" ? { action: "edit", text } : null;
    }
    case "reject":
      return { action: "reject" };
    default:
      return null;
  }
}

export async function POST(req: Request, ctx: RouteContext<"/inbox/drafts/[id]">) {
  if (!sameOrigin(req, inboxBaseUrl())) return html(403, "Not allowed", "<p>Please use your inbox page.</p>");
  const session = await getOwnerSession(readCookie(req, SESSION_COOKIE));
  if (!session) return signedOutPage();
  const decision = parse(await req.formData().catch(() => new FormData()));
  if (!decision) return html(400, "Something went wrong", '<p><a href="/inbox">Back to your inbox</a></p>');
  const { id } = await ctx.params;
  const result = await decide(session, id, decision);
  return redirect(`/inbox?done=${result.ok ? result.status : result.reason}`);
}
