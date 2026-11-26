// Review link redirect (SPEC FR-7, Flow 2 step 3): counts the click, then sends the customer to the business's
// Google review form. Unknown IDs and messages that never went out (never sent, or refused by the provider) get a
// plain 404; a send with an unknown outcome may have reached the customer, so its link works. Nothing about the
// request is revealed.
import { recordClick, reviewLinkFor } from "../../../requests/requests";

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" };

const redirect = (link: string | null) =>
  link
    ? new Response(null, { status: 302, headers: { ...headers, Location: link } })
    : new Response("Not found", { status: 404, headers });

export async function GET(_req: Request, ctx: RouteContext<"/r/[id]">) {
  const { id } = await ctx.params;
  return redirect(await recordClick(id));
}

// Link checkers often probe with HEAD; that is not a customer clicking, so it is not counted.
export async function HEAD(_req: Request, ctx: RouteContext<"/r/[id]">) {
  const { id } = await ctx.params;
  return redirect(await reviewLinkFor(id));
}
