// Landing-page waitlist: name, business, email, Google Maps link and what the business does. Rate-limited per IP;
// a repeat from the same email updates its row. The operator gets a notice; the values are never logged.
import { db as defaultDb, type Db } from "../db/client";
import { waitlistEntries } from "../db/schema";
import { allow, mail, normalizeEmail, type Deps } from "../accounts/accounts";

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

// Google Maps place links: google.<tld>/maps, maps.google.<tld>, and the share short links.
export function isMapsUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "maps.app.goo.gl" || host === "g.page") return u.pathname.length > 1;
  if (host === "goo.gl") return u.pathname.startsWith("/maps");
  const tld = "(com|[a-z]{2}|com?\\.[a-z]{2})"; // google.com, google.de, google.co.uk, google.com.au
  if (new RegExp(`^maps\\.google\\.${tld}$`).test(host)) return true;
  return new RegExp(`^google\\.${tld}$`).test(host) && u.pathname.startsWith("/maps");
}

export type WaitlistInput = { name: string; business: string; email: string; maps: string; kind: string };
export type WaitlistResult = { ok: true } | { ok: false; error: string } | { ok: false; limited: true };

export async function joinWaitlist(
  input: WaitlistInput,
  ip: string,
  deps: Pick<Deps, "email" | "operatorEmail" | "now">,
  db: Db = defaultDb,
): Promise<WaitlistResult> {
  const now = deps.now ?? new Date();
  const name = input.name.trim();
  const businessName = input.business.trim();
  const email = normalizeEmail(input.email);
  const mapsUrl = input.maps.trim();
  const businessKind = input.kind.trim();
  if (!name || name.length > 200) return { ok: false, error: "Write your name." };
  if (!businessName || businessName.length > 200) return { ok: false, error: "Write your business name." };
  if (email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, error: "Write a valid email address." };
  if (mapsUrl.length > 2000 || !isMapsUrl(mapsUrl))
    return { ok: false, error: "Paste the Google Maps link to your business." };
  if (!businessKind || businessKind.length > 500) return { ok: false, error: "Write what your business does." };
  if (!(await allow("waitlistIp", ip, now, db))) return { ok: false, limited: true };

  const row = { name, businessName, email: input.email.trim(), mapsUrl, businessKind };
  await db
    .insert(waitlistEntries)
    .values({ ...row, normalizedEmail: email, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: waitlistEntries.normalizedEmail, set: { ...row, updatedAt: now } });
  if (deps.operatorEmail)
    await mail(deps, deps.operatorEmail, `Waitlist: ${businessName}`, [
      `${name} (${row.email}) joined the waitlist.`,
      `Business: ${businessName}`,
      `What it does: ${businessKind}`,
      `Google Maps: ${mapsUrl}`,
    ]);
  return { ok: true };
}
