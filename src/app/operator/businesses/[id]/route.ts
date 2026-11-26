// One business (SPEC FR-1): edit its details, its locations, and add locations (a self-serve sign-up has none).
import { redirect } from "../../../../inbox/http";
import { getBusiness, parseBusinessInput, updateBusiness } from "../../../../operator/businesses";
import { bizValues, businessPage, formFields, notFound, requireOperator } from "../../../../operator/http";
import { savedNotice } from "../../../../operator/fields";

export async function GET(req: Request, ctx: RouteContext<"/operator/businesses/[id]">) {
  return requireOperator(req, async () => {
    const { id } = await ctx.params;
    const b = await getBusiness(id);
    if (!b) return notFound();
    return businessPage(b, bizValues(b), { notice: savedNotice(new URL(req.url).searchParams.get("saved")) });
  });
}

export async function POST(req: Request, ctx: RouteContext<"/operator/businesses/[id]">) {
  return requireOperator(req, async (session) => {
    const { id } = await ctx.params;
    const b = await getBusiness(id);
    if (!b) return notFound();
    const f = await formFields(req);
    const input = parseBusinessInput(f);
    if (!input.ok) return businessPage(b, bizValues(null, f), { businessErrors: input.errors });
    if (!(await updateBusiness(session, id, input.value))) return notFound();
    return redirect(`/operator/businesses/${id}?saved=business`);
  });
}
