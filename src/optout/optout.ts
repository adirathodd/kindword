// Opt-out handling (SPEC FR-8, Flow 2 step 4). Results, errors and audit rows carry IDs and codes only,
// never phone numbers, emails or message text.
import { createHmac, timingSafeEqual } from "node:crypto";
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

export function isOptOutMessage(body: string): boolean {
  const words = body
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  return (
    KEYWORDS.has(words.join("")) || // "s t o p", "opt out", "un-subscribe"
    words.some((w, i) => KEYWORDS.has(w) || (w === "opt" && words[i + 1] === "out"))
  );
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
  await provider.send(msg.to, msg.from, `You're unsubscribed from ${who}. No more messages will be sent.`);
  return { status: "opted_out", confirmation: "sent" };
}

// Unsubscribe link token: "<customerId>.<HMAC>". No address in the URL.
// shortcut: needs the customer row; a link clicked after offboarding deleted it does nothing. Upgrade to an
// encrypted (location, email) token if links must outlive customer deletion.
function sign(customerId: string) {
  const secret = process.env.UNSUBSCRIBE_SECRET;
  if (!secret || secret.length < 32) throw new Error("UNSUBSCRIBE_SECRET missing or shorter than 32 chars");
  return createHmac("sha256", secret).update(`unsubscribe:v1:${customerId}`).digest("base64url");
}

export const unsubscribeToken = (customerId: string) => `${customerId}.${sign(customerId)}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function optOutEmail(token: string, db: Db = defaultDb): Promise<"opted_out" | "invalid" | "unknown"> {
  const [id, sig] = token.split(".");
  if (!id || !sig || !UUID.test(id)) return "invalid";
  const want = Buffer.from(sign(id));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return "invalid";

  return db.transaction(async (tx) => {
    const [c] = await tx
      .select({ locationId: customers.locationId, email: customers.normalizedEmail })
      .from(customers)
      .where(eq(customers.id, id));
    if (!c?.email) return "unknown";
    await optOut(tx, c.locationId, "email", c.email, "customer_email");
    return "opted_out"; // idempotent: a second click is still "opted_out"
  });
}
