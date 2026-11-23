// Email unsubscribe (SPEC FR-6, FR-8; CAN-SPAM). GET shows a one-button page so link scanners that fetch URLs do not
// unsubscribe anyone; POST opts the address out at the location and platform-wide. Mail clients' one-click
// unsubscribe (RFC 8058, List-Unsubscribe-Post) POSTs here too. Pages never show the email address.
import { optOutEmail } from "../../../optout/optout";

const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "Referrer-Policy": "no-referrer",
};

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">${title}</h1>${body}</body></html>`,
    { status, headers },
  );

const invalid = () =>
  page("Link not valid", "<p>This unsubscribe link is not valid. Please use the link from your email.</p>", 400);

export async function GET(_req: Request, ctx: RouteContext<"/u/[token]">) {
  const { token } = await ctx.params;
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return invalid();
  return page(
    "Unsubscribe",
    `<p>Stop review request emails to this address?</p><form method="post"><button type="submit" style="font-size:1rem;padding:.5rem 1rem">Unsubscribe</button></form>`,
  );
}

export async function POST(_req: Request, ctx: RouteContext<"/u/[token]">) {
  const { token } = await ctx.params;
  if ((await optOutEmail(token)) === "invalid") return invalid();
  return page("You're unsubscribed", "<p>You will not receive any more review request emails from us.</p>");
}
