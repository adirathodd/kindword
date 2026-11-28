// Operator adds a location to a business (SPEC FR-1).
import { redirect } from "../../../../../inbox/http";
import { addLocation, getBusiness, parseLocationInput } from "../../../../../operator/businesses";
import {
  bizValues,
  businessPage,
  formFields,
  locValues,
  notFound,
  requireOperator,
} from "../../../../../operator/http";

export async function POST(req: Request, ctx: RouteContext<"/operator/businesses/[id]/locations">) {
  return requireOperator(req, async (session) => {
    const { id } = await ctx.params;
    const b = await getBusiness(id);
    if (!b) return notFound();
    const f = await formFields(req);
    const input = parseLocationInput(f);
    if (!input.ok)
      return businessPage(b, bizValues(b), { newLocation: locValues(null, f), newLocationErrors: input.errors });
    if (!(await addLocation(session, id, input.value))) return notFound();
    return redirect(`/operator/businesses/${id}?saved=location`);
  });
}
