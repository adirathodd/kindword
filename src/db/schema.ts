// Data model from docs/SPEC.md ("Data model"). Hard constraints live here as DB constraints.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  boolean,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const businessStatus = pgEnum("business_status", ["onboarding", "live", "paused", "offboarded"]);
export const oauthStatus = pgEnum("oauth_status", ["active", "refresh_failed", "revoked"]);
export const consentMethod = pgEnum("consent_method", ["signed_estimate", "web_form", "booking_form"]);
export const visitSource = pgEnum("visit_source", ["csv", "sheet"]);
export const channel = pgEnum("channel", ["sms", "email"]);
export const requestStatus = pgEnum("request_status", ["scheduled", "sent", "failed", "skipped"]);
export const skipReason = pgEnum("skip_reason", ["stale", "opted_out", "no_consent", "duplicate"]);
export const draftStatus = pgEnum("draft_status", [
  "draft",
  "awaiting_owner",
  "held",
  "approved",
  "rejected",
  "posted",
  "failed",
]);

export const businesses = pgTable(
  "businesses",
  {
    id: id(),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    vertical: text("vertical").notNull(),
    ownerName: text("owner_name"),
    ownerPhone: text("owner_phone"),
    ownerEmail: text("owner_email"),
    ownerContactConsentRef: text("owner_contact_consent_ref"),
    languages: text("languages")
      .array()
      .notNull()
      .default(sql`'{en}'::text[]`),
    toneNotes: text("tone_notes"),
    status: businessStatus("status").notNull().default("onboarding"),
  },
  (t) => [
    check("owner_phone_requires_consent", sql`${t.ownerPhone} is null or ${t.ownerContactConsentRef} is not null`),
  ],
);

export const locations = pgTable(
  "locations",
  {
    id: id(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    timezone: text("timezone").notNull(), // IANA, e.g. America/New_York
    reviewLink: text("review_link").notNull(),
    googleLocationId: text("google_location_id").unique(), // one row per Google Business Profile
    googleConnectedAt: ts("google_connected_at"),
    // E.164 Twilio number this location texts from; inbound texts to it map back here (FR-8 per-client suppression).
    smsNumber: text("sms_number").unique(),
  },
  (t) => [index().on(t.businessId), unique().on(t.id, t.businessId)],
);

export const oauthTokens = pgTable("oauth_tokens", {
  id: id(),
  locationId: uuid("location_id")
    .notNull()
    .unique() // one token per location (spec: Integrations, Google OAuth)
    .references(() => locations.id, { onDelete: "cascade" }),
  encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
  scopes: text("scopes").array().notNull(),
  expiresAt: ts("expires_at"),
  revokedAt: ts("revoked_at"),
  status: oauthStatus("status").notNull().default("active"),
});

export const consentAttestations = pgTable(
  "consent_attestations",
  {
    id: id(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    signedAt: ts("signed_at").notNull(),
    documentRef: text("document_ref").notNull(),
    listDescription: text("list_description").notNull(),
  },
  (t) => [unique().on(t.id, t.businessId)],
);

export const customers = pgTable(
  "customers",
  {
    id: id(),
    locationId: uuid("location_id").notNull(),
    businessId: uuid("business_id").notNull(), // denormalized so the attestation FK can be tenant-scoped
    name: text("name"),
    phone: text("phone"),
    email: text("email"),
    normalizedPhone: text("normalized_phone"), // E.164
    normalizedEmail: text("normalized_email"),
    language: text("language"),
    consentMethod: consentMethod("consent_method"),
    consentWordingVersion: text("consent_wording_version"),
    consentAt: ts("consent_at"),
    consentEvidenceRef: text("consent_evidence_ref"),
    attestationId: uuid("attestation_id"),
    optedOutAt: ts("opted_out_at"),
  },
  (t) => [
    foreignKey({
      name: "customers_location_fk",
      columns: [t.locationId, t.businessId],
      foreignColumns: [locations.id, locations.businessId],
    }).onDelete("cascade"),
    // The attestation must belong to the customer's own business. Cascade: no phone may outlive its consent
    // record, and NO ACTION would break business deletion (attestations cascade before customers do).
    foreignKey({
      name: "customers_attestation_fk",
      columns: [t.attestationId, t.businessId],
      foreignColumns: [consentAttestations.id, consentAttestations.businessId],
    }).onDelete("cascade"),
    // FR-3: a consent record is all five fields; an attestation alone is not one.
    check(
      "phone_requires_consent",
      sql`(${t.phone} is null and ${t.normalizedPhone} is null) or (
        ${t.consentMethod} is not null and ${t.consentWordingVersion} is not null and
        ${t.consentAt} is not null and ${t.consentEvidenceRef} is not null and ${t.attestationId} is not null)`,
    ),
    // Dedup keys must exist whenever the raw value does, or the unique constraints can be bypassed.
    check("phone_normalized", sql`(${t.phone} is null) = (${t.normalizedPhone} is null)`),
    check("email_normalized", sql`(${t.email} is null) = (${t.normalizedEmail} is null)`),
    check("has_contact", sql`${t.phone} is not null or ${t.email} is not null`),
    unique().on(t.locationId, t.normalizedPhone),
    unique().on(t.locationId, t.normalizedEmail),
  ],
);

export const visits = pgTable(
  "visits",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    visitAt: ts("visit_at").notNull(),
    source: visitSource("source").notNull(),
    externalVisitId: text("external_visit_id").notNull(),
  },
  (t) => [unique().on(t.locationId, t.source, t.externalVisitId), index().on(t.customerId)],
);

export const reviewRequests = pgTable(
  "review_requests",
  {
    id: id(),
    visitId: uuid("visit_id")
      .notNull()
      .references(() => visits.id, { onDelete: "cascade" }),
    scheduledFor: ts("scheduled_for").notNull(),
    sentAt: ts("sent_at"),
    channel: channel("channel").notNull(),
    status: requestStatus("status").notNull().default("scheduled"),
    skipReason: skipReason("skip_reason"),
    providerMessageId: text("provider_message_id"),
    attempt: smallint("attempt").notNull(),
    clickedAt: ts("clicked_at"),
  },
  (t) => [
    unique().on(t.visitId, t.channel, t.attempt),
    check("attempt_1_or_2", sql`${t.attempt} in (1, 2)`), // request or the one reminder
    check("skip_reason_iff_skipped", sql`(${t.status} = 'skipped') = (${t.skipReason} is not null)`),
    index().on(t.status, t.scheduledFor),
  ],
);

export const suppressionList = pgTable(
  "suppression_list",
  {
    id: id(),
    locationId: uuid("location_id").references(() => locations.id, {
      onDelete: "cascade",
    }), // null = platform-wide
    channel: channel("channel").notNull(),
    address: text("address").notNull(), // normalized phone (E.164) or email
    createdAt: ts("created_at").notNull().defaultNow(),
    source: text("source").notNull(),
  },
  // NULLS NOT DISTINCT so platform-wide (null location) entries are unique too.
  (t) => [unique().on(t.locationId, t.channel, t.address).nullsNotDistinct(), index().on(t.channel, t.address)],
);

export const reviews = pgTable(
  "reviews",
  {
    id: id(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    googleReviewId: text("google_review_id").notNull().unique(),
    rating: smallint("rating").notNull(),
    text: text("text"),
    reviewerName: text("reviewer_name"),
    language: text("language"),
    postedAt: ts("posted_at"),
    fetchedAt: ts("fetched_at").notNull().defaultNow(),
    flags: text("flags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    hasReply: boolean("has_reply").notNull().default(false),
  },
  (t) => [
    check("rating_1_to_5", sql`${t.rating} between 1 and 5`),
    index().on(t.fetchedAt), // fetched_at drives the 30-day purge
    unique().on(t.id, t.locationId),
  ],
);

export const ownerSessions = pgTable(
  "owner_sessions",
  {
    id: id(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    ownerEmail: text("owner_email").notNull(),
    loginTokenHash: text("login_token_hash").notNull().unique(),
    tokenExpiresAt: ts("token_expires_at").notNull(),
    sessionExpiresAt: ts("session_expires_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [unique().on(t.id, t.locationId)],
);

export const replyDrafts = pgTable(
  "reply_drafts",
  {
    id: id(),
    reviewId: uuid("review_id").notNull(),
    locationId: uuid("location_id").notNull(), // denormalized so review and approving session share one location
    draftText: text("draft_text").notNull(),
    finalText: text("final_text"),
    status: draftStatus("status").notNull().default("draft"),
    model: text("model").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    approvedSessionId: uuid("approved_session_id"),
    approvedAt: ts("approved_at"),
    postedAt: ts("posted_at"),
  },
  (t) => [
    // Purged with its review.
    foreignKey({
      name: "reply_drafts_review_fk",
      columns: [t.reviewId, t.locationId],
      foreignColumns: [reviews.id, reviews.locationId],
    }).onDelete("cascade"),
    // Only a session for this draft's location can approve it. Cascade, not NO ACTION, so location deletion
    // works (sessions cascade before drafts do); sessions are revoked, not deleted, in normal use.
    foreignKey({
      name: "reply_drafts_session_fk",
      columns: [t.approvedSessionId, t.locationId],
      foreignColumns: [ownerSessions.id, ownerSessions.locationId],
    }).onDelete("cascade"),
    check("approved_requires_session", sql`${t.approvedAt} is null or ${t.approvedSessionId} is not null`),
    // Never post without approval.
    check("posted_requires_approval", sql`${t.postedAt} is null or ${t.approvedAt} is not null`),
    // At most one posted reply per review (guards approve/post races).
    uniqueIndex("one_posted_reply_per_review")
      .on(t.reviewId)
      .where(sql`${t.status} = 'posted'`),
  ],
);

// Append-only; no FK so rows survive business deletion (IDs and actions only).
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    locationId: uuid("location_id"),
    entity: text("entity").notNull(),
    entityId: uuid("entity_id"),
    action: text("action").notNull(),
    actor: text("actor").notNull(),
    detail: text("detail"), // never review text or phone numbers
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [index().on(t.locationId, t.at)],
);

export const sheetSources = pgTable("sheet_sources", {
  id: id(),
  locationId: uuid("location_id")
    .notNull()
    .unique() // one shared sheet per location
    .references(() => locations.id, { onDelete: "cascade" }),
  sheetId: text("sheet_id").notNull(),
  // Set by the operator, like importCsv's per-upload context; polling refuses to run while either is null.
  attestationId: uuid("attestation_id").references(() => consentAttestations.id, { onDelete: "set null" }),
  consentWordingVersion: text("consent_wording_version"),
  lastRowId: text("last_row_id"), // progress marker only; dedup is by row ID in visits.external_visit_id
  lastReadAt: ts("last_read_at"),
});
