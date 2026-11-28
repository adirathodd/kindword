// Operator edits one location of a business (SPEC FR-1). A location of another business is not found.
import { redirect } from "../../../../../../inbox/http";
import { getBusiness, parseLocationInput, updateLocation } from "../../../../../../operator/businesses";
import {
  bizValues,
  businessPage,
  formFields,
  locValues,
  notFound,
  requireOperator,
} from "../../../../../../operator/http";

export async function POST(req: Request, ctx: RouteContext<"/operator/businesses/[id]/locations/[locationId]">) {
  return requireOperator(req, async (session) => {
    const { id, locationId } = await ctx.params;
    const b = await getBusiness(id);
    if (!b || !b.locations.some((l) => l.id === locationId)) return notFound();
    const f = await formFields(req);
    const input = parseLocationInput(f);
    if (!input.ok)
      return businessPage(b, bizValues(b), {
        editing: { id: locationId, values: locValues(null, f), errors: input.errors },
      });
    if (!(await updateLocation(session, id, locationId, input.value))) return notFound();
    return redirect(`/operator/businesses/${id}?saved=location`);
  });
}
