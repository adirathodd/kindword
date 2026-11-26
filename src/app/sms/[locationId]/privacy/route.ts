// SMS privacy policy for one location's review-request texts (FR-23). Public and stable: the URL goes into its 10DLC campaign.
import { smsPrivacyBody, loadProgram } from "../../../../compliance/compliance";
import { html } from "../../../../inbox/http";

export async function GET(_req: Request, ctx: RouteContext<"/sms/[locationId]/privacy">) {
  const p = await loadProgram((await ctx.params).locationId);
  return p
    ? html(200, `SMS privacy policy: ${p.name}`, smsPrivacyBody(p))
    : html(404, "Page not found", "<p>This page does not exist.</p>");
}
