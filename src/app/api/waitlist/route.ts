// Landing-page waitlist form (public/landing/index.html #waitlist). The page sends it by fetch and reads JSON;
// without scripts the browser posts it and gets a short HTML page back.
import { clientIp, formFields, notAllowed, routeDeps, tooMany } from "../../../accounts/http";
import { inboxBaseUrl } from "../../../inbox/auth";
import { html, sameOrigin } from "../../../inbox/http";
import { joinWaitlist } from "../../../waitlist/waitlist";

export async function POST(req: Request) {
  if (!sameOrigin(req, inboxBaseUrl())) return notAllowed();
  const f = await formFields(req);
  const input = { name: f("name"), business: f("business"), email: f("email"), maps: f("maps"), kind: f("kind") };
  const r = await joinWaitlist(input, clientIp(req), routeDeps.make());
  const json = req.headers.get("accept")?.includes("application/json");
  if (!r.ok && "limited" in r) return json ? Response.json({ ok: false }, { status: 429 }) : tooMany();
  if (!r.ok)
    return json
      ? Response.json({ ok: false, error: r.error }, { status: 400 })
      : html(400, "Not sent", `<p>${r.error}</p><p><a href="/#waitlist">Back to the form</a></p>`);
  return json
    ? Response.json({ ok: true })
    : html(200, "You're on the waitlist", '<p>We will email you soon.</p><p><a href="/">Back to Kindword</a></p>');
}
