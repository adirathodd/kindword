// SMS terms for one location's review-request texts (FR-23). Public and stable: the URL goes into its 10DLC campaign.
import { smsTermsBody, loadProgram } from "../../../../compliance/compliance";
import { html } from "../../../../inbox/http";

export async function GET(_req: Request, ctx: RouteContext<"/sms/[locationId]/terms">) {
  const p = await loadProgram((await ctx.params).locationId);
  return p
    ? html(200, `SMS terms: ${p.name}`, smsTermsBody(p))
    : html(404, "Page not found", "<p>This page does not exist.</p>");
}
