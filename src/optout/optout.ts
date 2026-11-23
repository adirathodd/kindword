// Opt-out handling (SPEC FR-8, Flow 2 step 4). Results, errors and audit rows carry IDs and codes only,
// never phone numbers, emails or message text.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { auditLog, businesses, channel, customers, locations, suppressionList } from "../db/schema";
import { normalizePhone } from "../intake/normalize";
import type { SmsProvider } from "../sms/provider";

type Channel = (typeof channel.enumValues)[number];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Twilio's single-word keywords plus our own; matched as whole words so "stop please" and "STOP!!" count.
// A false positive costs one review request; a missed opt-out is TCPA exposure, so we err toward matching.
const KEYWORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "revoke", "optout"]);
const LONGEST = Math.max(...[...KEYWORDS].map((k) => k.length));

// FR-8 strips punctuation and spaces before matching, so a keyword split by them counts anywhere in the message:
// any run of adjacent whole words that joins into a keyword ("opt out", "un-subscribe me", "please s t o p").
// Only whole words are joined, so "I stopped by" and "nonstop" still don't match.
export function isOptOutMessage(body: string): boolean {
  const words = body
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  return words.some((_, i) => {
    let run = "";
    for (let j = i; j < words.length && run.length < LONGEST; j++) {
      run += words[j];
      if (KEYWORDS.has(run)) return true;
    }
    return false;
  });
}

const normalize = (ch: Channel, address: string) =>
  ch === "sms" ? (normalizePhone(address) ?? address) : address.trim().toLowerCase();

// Called before every send: true if the address is suppressed at this location or platform-wide.
export async function isSuppressed(locationId: string, ch: Channel, address: string, db: Db = defaultDb) {
  const [row] = await db
    .select({ id: suppressionList.id })
    .from(suppressionList)
    .where(
      and(
        eq(suppressionList.channel, ch),
        eq(suppressionList.address, normalize(ch, address)),
        or(isNull(suppressionList.locationId), eq(suppressionList.locationId, locationId)),
      ),
    )
    .limit(1);
  return !!row;
}

// Adds the location row (if known) and the platform-wide row, marks the location's customer opted out, and audits.
// Returns true only the first time this location (or, with no location, the platform) records the opt-out,
// so a retried webhook or second STOP changes nothing and triggers no confirmation.
async function optOut(tx: Tx, locationId: string | null, ch: Channel, address: string, actor: string) {
  const add = async (loc: string | null) =>
    (
      await tx
        .insert(suppressionList)
        .values({ locationId: loc, channel: ch, address, source: actor })
        .onConflictDoNothing()
        .returning({ id: suppressionList.id })
    ).length > 0;
  const isNew = locationId ? await add(locationId) : false;
  const platformNew = await add(null);
  const first = locationId ? isNew : platformNew;
  if (!first) return false;

  const addressCol = ch === "sms" ? customers.normalizedPhone : customers.normalizedEmail;
  const updated = locationId
    ? await tx
        .update(customers)
        .set({ optedOutAt: sql`coalesce(${customers.optedOutAt}, now())` })
        .where(and(eq(customers.locationId, locationId), eq(addressCol, address)))
        .returning({ id: customers.id })
    : [];
  await tx.insert(auditLog).values({
    locationId,
    entity: "customer",
    entityId: updated[0]?.id ?? null,
    action: "opted_out",
    actor,
    detail: `channel=${ch};scope=${locationId ? "location,platform" : "platform"}`,
  });
  return true;
}

export type InboundResult =
  { status: "rejected" | "ignored" } | { status: "opted_out"; confirmation: "sent" | "provider" | "none" };

export async function handleInboundSms(
  provider: SmsProvider,
  req: Request,
  db: Db = defaultDb,
): Promise<InboundResult> {
  const msg = await provider.parseInbound(req);
  if (!msg) return { status: "rejected" };
  if (!isOptOutMessage(msg.body)) return { status: "ignored" }; // HELP and everything else: Twilio's job or nothing
  const from = normalizePhone(msg.from);
  if (!from) return { status: "ignored" }; // not a US number, so never one we texted

  const { first, businessName } = await db.transaction(async (tx) => {
    const [loc] = await tx
      .select({ id: locations.id, businessName: businesses.name })
      .from(locations)
      .innerJoin(businesses, eq(businesses.id, locations.businessId))
      .where(eq(locations.smsNumber, normalizePhone(msg.to) ?? msg.to));
    return { first: await optOut(tx, loc?.id ?? null, "sms", from, "customer_sms"), businessName: loc?.businessName };
  });

  // Sent after commit: a crash here loses the confirmation but can never send two.
  if (!first) return { status: "opted_out", confirmation: "none" };
  if (msg.providerHandled) return { status: "opted_out", confirmation: "provider" };
  const who = businessName ? `${businessName} texts` : "these texts";
  try {
    await provider.send(msg.to, msg.from, `You're unsubscribed from ${who}. No more messages will be sent.`);
  } catch (e) {
    // The provider already has the sender opted out (Twilio 21610: they texted one of its keywords and its built-in
    // reply confirmed it), so the one confirmation went out and this is not a failure (Flow 2 step 4).
    if ((e as { recipientOptedOut?: unknown } | null)?.recipientOptedOut === true)
      return { status: "opted_out", confirmation: "provider" };
    throw e;
  }
  return { status: "opted_out", confirmation: "sent" };
}

// Unsubscribe link token: AES-256-GCM over (location, email), so the URL shows no address, can't be forged,
// and still works after the customer or location row is deleted (CAN-SPAM: links must work 30 days after sending).
function key() {
  const secret = process.env.UNSUBSCRIBE_SECRET;
  if (!secret || secret.length < 32) throw new Error("UNSUBSCRIBE_SECRET missing or shorter than 32 chars");
  return createHash("sha256").update(`unsubscribe:v1:${secret}`).digest();
}

export function unsubscribeToken(locationId: string, email: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(`${locationId}|${normalize("email", email)}`, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}

function readToken(token: string): { locationId: string; email: string } | null {
  const raw = Buffer.from(token, "base64url");
  if (raw.length < 29) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
    const i = text.indexOf("|"); // first "|" only: an email's local part may contain one
    return i > 0 ? { locationId: text.slice(0, i), email: text.slice(i + 1) } : null;
  } catch {
    return null; // tampered, truncated or signed with another key; never echo the token
  }
}

export async function optOutEmail(token: string, db: Db = defaultDb): Promise<"opted_out" | "invalid"> {
  const t = readToken(token);
  if (!t) return "invalid";
  return db.transaction(async (tx) => {
    // A deleted location gets the platform-wide entry only (a location row would violate its FK).
    const [loc] = await tx.select({ id: locations.id }).from(locations).where(eq(locations.id, t.locationId));
    await optOut(tx, loc?.id ?? null, "email", t.email, "customer_email");
    return "opted_out" as const; // idempotent: a second click is still "opted_out"
  });
}
