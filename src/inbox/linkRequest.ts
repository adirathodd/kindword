// "Email me a sign-in link" on the owner sign-in screen (SPEC FR-13): a signed-out owner enters their email and gets
// a passwordless sign-in link for each of their business's locations (single use, 15 minutes, each scoped to one
// location, as createSignInLink makes them). The answer is the same whether or not the email belongs to an owner,
// and requests are rate-limited per IP and per email.
// The owner is matched on the business's owner_email, the address createSignInLink sends to, so an owner the
// operator set up without an account can sign in too. No link goes to an offboarded business or a disabled account.
// When the owner has an account (FR-24), the sessions the links start are tied to it, so a password reset ends them.
// Nothing here logs or audits the email address; audit rows carry IDs only.
import { and, asc, count, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { authAttempts, businesses, locations, ownerAccounts } from "../db/schema";
import { afterResponse, type Later } from "../accounts/accounts";
import type { EmailProvider } from "../email/provider";
import { createSignInLink, escapeHtml, sha256 } from "./auth";

const MINUTE = 60 * 1000;
// The same limits as a password-reset request, which also emails a short-lived link.
export const LINK_LIMITS = {
  signInLinkIp: { max: 10, windowMs: 60 * MINUTE },
  signInLinkEmail: { max: 5, windowMs: 60 * MINUTE },
} as const;

// Same shape check as sign-up (src/accounts/accounts.ts).
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

// Records one attempt in auth_attempts (keys are hashes, so no email or IP is stored) and says whether it is within
// the limit. Same table and rule as the account limits; old rows are cleared as a side effect.
// shortcut: count-then-insert can let a burst of parallel requests slightly overshoot; fine for abuse limits.
async function allow(limit: keyof typeof LINK_LIMITS, value: string, now: Date, db: Db) {
  const { max, windowMs } = LINK_LIMITS[limit];
  const key = sha256(`${limit}:${value}`);
  await db.delete(authAttempts).where(lt(authAttempts.at, new Date(now.getTime() - 24 * 60 * MINUTE)));
  const [{ n }] = await db
    .select({ n: count() })
    .from(authAttempts)
    .where(and(eq(authAttempts.key, key), gt(authAttempts.at, new Date(now.getTime() - windowMs))));
  await db.insert(authAttempts).values({ key, at: now });
  return n < max;
}

export type LinkRequestDeps = { email: EmailProvider; baseUrl: string; now?: Date; later?: Later };
export type LinkRequestResult = { ok: true } | { ok: false; error: string } | { ok: false; limited: true };

// ok:true means "if that email is an owner's, we sent a link", whether or not anything was sent.
export async function requestSignInLinks(
  emailInput: string,
  ip: string,
  deps: LinkRequestDeps,
  db: Db = defaultDb,
): Promise<LinkRequestResult> {
  const now = deps.now ?? new Date();
  const email = emailInput.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };
  const okIp = await allow("signInLinkIp", ip, now, db);
  const okEmail = await allow("signInLinkEmail", email, now, db);
  if (!okIp || !okEmail) return { ok: false, limited: true };
  // The lookup, links and emails run after the response, so a known email answers as fast as an unknown one.
  await afterResponse(deps, "sign-in link email", () => sendLinks(email, deps, now, db));
  return { ok: true };
}

async function sendLinks(email: string, deps: LinkRequestDeps, now: Date, db: Db) {
  const owned = await db
    .select({
      businessId: businesses.id,
      businessName: businesses.name,
      accountId: ownerAccounts.id,
      accountEmail: ownerAccounts.normalizedEmail,
      accountDisabledAt: ownerAccounts.disabledAt,
    })
    .from(businesses)
    .leftJoin(ownerAccounts, eq(ownerAccounts.businessId, businesses.id))
    .where(and(sql`lower(trim(${businesses.ownerEmail})) = ${email}`, ne(businesses.status, "offboarded")));
  const eligible = owned.filter((b) => !b.accountDisabledAt);
  if (!eligible.length) return;

  const locs = await db
    .select({ id: locations.id, name: locations.name, businessId: locations.businessId })
    .from(locations)
    .where(
      inArray(
        locations.businessId,
        eligible.map((b) => b.businessId),
      ),
    )
    .orderBy(asc(locations.name), asc(locations.id));

  for (const b of eligible) {
    const mine = locs.filter((l) => l.businessId === b.businessId);
    if (!mine.length) continue; // no inbox yet (still in setup); the account page covers that
    const accountId = b.accountId && b.accountEmail === email ? b.accountId : undefined;
    const links = [];
    for (const l of mine)
      links.push({ name: l.name, ...(await createSignInLink(l.id, { baseUrl: deps.baseUrl, now, accountId }, db)) });
    // FR-13: the same response whether or not the email belongs to an owner, including when the email provider
    // fails (only a known email reaches this send, so a thrown error would answer differently). The unsent links
    // are single use and expire in 15 minutes; the owner can ask again. No address or error text is logged.
    try {
      await deps.email.send(signInLinkEmail(b.businessName, links));
    } catch {
      console.warn("sign-in link email not sent");
    }
  }
}

// One email per business, one link per location. A transactional message to the owner, so no unsubscribe footer.
function signInLinkEmail(businessName: string, links: { name: string; url: string; ownerEmail: string }[]) {
  const one = links.length === 1;
  const intro = one
    ? `Use this link to open the review reply inbox for ${businessName} (${links[0].name}):`
    : `Use these links to open the review reply inboxes for ${businessName}. Each opens one location:`;
  const rules =
    "Each link works once and expires in 15 minutes. After you sign in, you stay signed in on this device for 30 days.";
  const ignore = "If you did not ask for this email, you can ignore it.";
  const text = [
    intro,
    "",
    ...links.flatMap((l) => (one ? [l.url, ""] : [`${l.name}: ${l.url}`, ""])),
    rules,
    ignore,
  ].join("\n");
  const html = `<p>${escapeHtml(intro)}</p>${links
    .map(
      (l) =>
        `<p><a href="${escapeHtml(l.url)}">${escapeHtml(one ? "Open the reply inbox" : `Open the reply inbox: ${l.name}`)}</a></p>`,
    )
    .join("")}<p>${escapeHtml(rules)}</p><p>${escapeHtml(ignore)}</p>`;
  return {
    to: links[0].ownerEmail,
    fromName: "Kindword",
    subject: `Sign in to your review reply inbox: ${businessName}`,
    text,
    html,
    headers: {},
  };
}
