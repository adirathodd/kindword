// Operator creates a business and its first location (SPEC FR-1, Flow 1 step 1). It starts in onboarding.
import { redirect } from "../../../../inbox/http";
import { createBusinessWithLocation, parseBusinessInput, parseLocationInput } from "../../../../operator/businesses";
import { bizValues, formFields, locValues, newBusinessPage, requireOperator } from "../../../../operator/http";
import { prefixed } from "../../../../operator/fields";

export async function GET(req: Request) {
  return requireOperator(req, async () => newBusinessPage(bizValues(), locValues()));
}

export async function POST(req: Request) {
  return requireOperator(req, async (session) => {
    const f = await formFields(req);
    const lf = prefixed(f, "location.");
    const b = parseBusinessInput(f);
    const l = parseLocationInput(lf);
    if (!b.ok || !l.ok)
      return newBusinessPage(bizValues(null, f), locValues(null, lf), {
        business: b.ok ? undefined : b.errors,
        location: l.ok ? undefined : l.errors,
      });
    const r = await createBusinessWithLocation(session, b.value, l.value);
    return redirect(`/operator/businesses/${r.businessId}?saved=created`);
  });
}
