// Operator setup of businesses and locations (SPEC FR-1, Flow 1 step 1): name, Google review link, time zone,
// languages and tone notes, plus the approved facts the reply drafter may use (src/reviews/draft.ts). A new business
// starts in onboarding; nothing here changes a business's status (going live is Flow 1 step 5, its own item).
// Every function takes the operator session (src/operator/auth.ts); audit rows carry IDs and field names only.
import { and, asc, count, eq } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { auditLog, businesses, locations } from "../db/schema";
import { UUID_RE } from "../inbox/auth";
import type { OperatorSession } from "./auth";

// Home services only (SPEC Decisions: no healthcare or finance). home_services is the self-serve sign-up default.
export const VERTICALS = [
  { id: "hvac", label: "HVAC" },
  { id: "plumbing", label: "Plumbing" },
  { id: "electrical", label: "Electrical" },
  { id: "roofing", label: "Roofing" },
  { id: "cleaning", label: "Cleaning" },
  { id: "landscaping", label: "Landscaping" },
  { id: "pest_control", label: "Pest control" },
  { id: "home_services", label: "Other home service" },
] as const;
// Languages review requests and replies support (src/requests/messages.ts).
export const LANGUAGES = [
  { id: "en", label: "English" },
  { id: "es", label: "Spanish" },
] as const;
// Where a Google review link may point: short links anywhere on their host, and on the main Google hosts only the
// write-review page and Maps (not, say, www.google.com/url?q=..., a redirect to any site).
const REVIEW_LINKS: Record<string, RegExp> = {
  "g.page": /^\//,
  "g.co": /^\//,
  "maps.app.goo.gl": /^\//,
  "search.google.com": /^\/local\/writereview(\/|$)/,
  "www.google.com": /^\/maps(\/|$)/,
};
const MAX_NAME = 120;
const MAX_TONE = 1000;
const MAX_FACTS = 2000;
const MAX_LINK = 500;

export type Fields = { get(name: string): string; all(name: string): string[] };
export type BusinessInput = {
  name: string;
  vertical: string;
  languages: string[];
  toneNotes: string | null;
  approvedFacts: string | null;
};
export type LocationInput = { name: string; reviewLink: string; timezone: string };
type Parsed<T> = { ok: true; value: T } | { ok: false; errors: Partial<Record<keyof T, string>> };

const text = (s: string) => s.replace(/\r\n/g, "\n").trim();
const optional = (s: string) => text(s) || null;

export function parseBusinessInput(f: Fields): Parsed<BusinessInput> {
  const errors: Partial<Record<keyof BusinessInput, string>> = {};
  const name = text(f.get("name"));
  if (!name || name.length > MAX_NAME) errors.name = `Enter a name of up to ${MAX_NAME} characters.`;
  const vertical = f.get("vertical");
  if (!VERTICALS.some((v) => v.id === vertical)) errors.vertical = "Choose the type of home service.";
  const chosen = new Set(f.all("languages"));
  const languages = LANGUAGES.map((l) => l.id).filter((id) => chosen.has(id));
  if (!languages.length || [...chosen].some((l) => !LANGUAGES.some((x) => x.id === l)))
    errors.languages = "Choose English, Spanish or both.";
  const toneNotes = optional(f.get("toneNotes"));
  if (toneNotes && toneNotes.length > MAX_TONE) errors.toneNotes = `Keep tone notes under ${MAX_TONE} characters.`;
  const approvedFacts = optional(f.get("approvedFacts"));
  if (approvedFacts && approvedFacts.length > MAX_FACTS)
    errors.approvedFacts = `Keep approved facts under ${MAX_FACTS} characters.`;
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { name, vertical, languages, toneNotes, approvedFacts } };
}

// Any zone the runtime knows, including aliases supportedValuesOf leaves out (UTC, Asia/Kolkata). Area/City or UTC
// only, so offsets like "+05:00" (which Intl also accepts) are refused.
export function isTimeZone(tz: string) {
  if (!/^(UTC|Etc\/UTC|[A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2})$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function parseLocationInput(f: Fields): Parsed<LocationInput> {
  const errors: Partial<Record<keyof LocationInput, string>> = {};
  const name = text(f.get("name"));
  if (!name || name.length > MAX_NAME) errors.name = `Enter a location name of up to ${MAX_NAME} characters.`;
  const reviewLink = f.get("reviewLink").trim();
  let url: URL | null = null;
  try {
    url = reviewLink.length <= MAX_LINK ? new URL(reviewLink) : null;
  } catch {
    url = null;
  }
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !Object.hasOwn(REVIEW_LINKS, url.hostname) ||
    !REVIEW_LINKS[url.hostname].test(url.pathname)
  )
    errors.reviewLink = "Enter the business's Google review link (https://g.page/..., search.google.com or Maps).";
  const timezone = f.get("timezone").trim();
  if (!isTimeZone(timezone)) errors.timezone = "Choose a time zone such as America/New_York.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { name, reviewLink, timezone } };
}

const actor = (s: OperatorSession) => `operator_session:${s.sessionId}`;

export async function listBusinesses(db: Db = defaultDb) {
  return db
    .select({
      id: businesses.id,
      name: businesses.name,
      vertical: businesses.vertical,
      status: businesses.status,
      locations: count(locations.id),
    })
    .from(businesses)
    .leftJoin(locations, eq(locations.businessId, businesses.id))
    .groupBy(businesses.id)
    .orderBy(asc(businesses.status), asc(businesses.name));
}

export async function getBusiness(id: string, db: Db = defaultDb) {
  if (!UUID_RE.test(id)) return null;
  const [b] = await db
    .select({
      id: businesses.id,
      name: businesses.name,
      vertical: businesses.vertical,
      languages: businesses.languages,
      toneNotes: businesses.toneNotes,
      approvedFacts: businesses.approvedFacts,
      status: businesses.status,
    })
    .from(businesses)
    .where(eq(businesses.id, id));
  if (!b) return null;
  const locs = await db
    .select({
      id: locations.id,
      name: locations.name,
      reviewLink: locations.reviewLink,
      timezone: locations.timezone,
    })
    .from(locations)
    .where(eq(locations.businessId, id))
    .orderBy(asc(locations.name));
  return { ...b, locations: locs };
}

export async function createBusinessWithLocation(
  session: OperatorSession,
  b: BusinessInput,
  l: LocationInput,
  opts: { now?: Date } = {},
  db: Db = defaultDb,
) {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const [biz] = await tx.insert(businesses).values(b).returning({ id: businesses.id });
    const [loc] = await tx
      .insert(locations)
      .values({ businessId: biz.id, ...l })
      .returning({ id: locations.id });
    await tx.insert(auditLog).values([
      { entity: "business", entityId: biz.id, action: "created", actor: actor(session), at: now },
      { locationId: loc.id, entity: "location", entityId: loc.id, action: "created", actor: actor(session), at: now },
    ]);
    return { businessId: biz.id, locationId: loc.id };
  });
}

// True when the business exists. Status is never changed here.
export async function updateBusiness(
  session: OperatorSession,
  id: string,
  b: BusinessInput,
  opts: { now?: Date } = {},
  db: Db = defaultDb,
) {
  if (!UUID_RE.test(id)) return false;
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const [old] = await tx.select().from(businesses).where(eq(businesses.id, id)).for("update");
    if (!old) return false;
    const changed = (Object.keys(b) as (keyof BusinessInput)[]).filter(
      (k) => JSON.stringify(old[k]) !== JSON.stringify(b[k]),
    );
    await tx.update(businesses).set(b).where(eq(businesses.id, id));
    await tx.insert(auditLog).values({
      entity: "business",
      entityId: id,
      action: "updated",
      actor: actor(session),
      detail: `fields=${changed.join(",") || "none"}`,
      at: now,
    });
    return true;
  });
}

// The new location's ID, or null when the business does not exist.
export async function addLocation(
  session: OperatorSession,
  businessId: string,
  l: LocationInput,
  opts: { now?: Date } = {},
  db: Db = defaultDb,
) {
  if (!UUID_RE.test(businessId)) return null;
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const [biz] = await tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId));
    if (!biz) return null;
    const [loc] = await tx
      .insert(locations)
      .values({ businessId, ...l })
      .returning({ id: locations.id });
    await tx.insert(auditLog).values({
      locationId: loc.id,
      entity: "location",
      entityId: loc.id,
      action: "created",
      actor: actor(session),
      at: now,
    });
    return loc.id;
  });
}

// True when the location exists and belongs to this business.
export async function updateLocation(
  session: OperatorSession,
  businessId: string,
  locationId: string,
  l: LocationInput,
  opts: { now?: Date } = {},
  db: Db = defaultDb,
) {
  if (!UUID_RE.test(businessId) || !UUID_RE.test(locationId)) return false;
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const [old] = await tx
      .select()
      .from(locations)
      .where(and(eq(locations.id, locationId), eq(locations.businessId, businessId)))
      .for("update");
    if (!old) return false;
    const changed = (Object.keys(l) as (keyof LocationInput)[]).filter((k) => old[k] !== l[k]);
    await tx.update(locations).set(l).where(eq(locations.id, locationId));
    await tx.insert(auditLog).values({
      locationId,
      entity: "location",
      entityId: locationId,
      action: "updated",
      actor: actor(session),
      detail: `fields=${changed.join(",") || "none"}`,
      at: now,
    });
    return true;
  });
}
