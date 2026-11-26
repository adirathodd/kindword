// Hosted SMS opt-in page for one location (FR-23). Public and stable: its URL goes into the client's 10DLC campaign.
// GET shows the form (box unchecked); POST records a consent only when the box is checked and the number is valid.
import { clientIp, formFields, notAllowed, tooMany } from "../../../accounts/http";
import { loadProgram, optInBody, recordOptIn } from "../../../compliance/compliance";
import { escapeHtml, inboxBaseUrl } from "../../../inbox/auth";
import { html, sameOrigin } from "../../../inbox/http";

const notFound = () => html(404, "Page not found", "<p>This page does not exist.</p>");
const title = (name: string) => `Text updates from ${name}`;

export async function GET(_req: Request, ctx: RouteContext<"/sms/[locationId]">) {
  const p = await loadProgram((await ctx.params).locationId);
  return p ? html(200, title(p.name), optInBody(p)) : notFound();
}

export async function POST(req: Request, ctx: RouteContext<"/sms/[locationId]">) {
  if (!sameOrigin(req, inboxBaseUrl())) return notAllowed();
  const p = await loadProgram((await ctx.params).locationId);
  if (!p) return notFound();
  const f = await formFields(req);
  const r = await recordOptIn(p, { phone: f("phone"), consent: f("consent") === "yes" }, clientIp(req));
  if (!r.ok && "limited" in r) return tooMany();
  if (!r.ok) return html(400, title(p.name), optInBody(p, r.error, r.phone));
  return html(
    200,
    "You're signed up",
    `<p>${escapeHtml(p.name)} may text you after your job to ask for a review. Up to 2 texts per job. Reply STOP to any text to opt out.</p>`,
  );
}
