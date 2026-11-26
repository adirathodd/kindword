// Data model from docs/SPEC.md ("Data model"). Hard constraints live here as DB constraints.
import { sql } from "drizzle-orm";
import {
  bigint,
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
// clicked: a reminder not sent because the customer clicked the review link after it was scheduled (FR-5).
export const skipReason = pgEnum("skip_reason", ["stale", "opted_out", "no_consent", "duplicate", "clicked"]);
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
    // Facts a reply may use (hours, the phone or email for taking a complaint offline). Set by the operator at
    // onboarding; the AI drafter may use nothing else about the business (SPEC: AI reply generation, rule 4).
    approvedFacts: text("approved_facts"),
    status: businessStatus("status").notNull().default("onboarding"),
    // When the business was switched to offboarded. Set and cleared by a database trigger (migration 0016) whenever
    // status changes, so no code path can offboard without it. Everything for the business is deleted within 30 days
    // of this time (SPEC Security, Retention; src/retention/businesses.ts).
    offboardedAt: ts("offboarded_at"),
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
    timezone: text("timezone").notNull(), // IANA, e.g. America/New_York; trigger locations_timezone_valid (0014)
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
    // A failed send that may still have reached the customer (timeout, lost connection, ambiguous 5xx). Counts as
    // asked for FR-9.
    outcomeUnknown: boolean("outcome_unknown").notNull().default(false),
    // Email sends that hit a retryable provider error (F-12-2): how many sends were tried, and when the first one that
    // may have reached the customer was. A retry reuses the Resend idempotency key, which Resend keeps for 24 hours,
    // so no retry goes out more than EMAIL_RETRY_WINDOW_MS after maybe_sent_at. A row with maybe_sent_at counts as
    // asked (FR-9) and keeps its link working (FR-7) whatever its status.
    sendAttempts: smallint("send_attempts").notNull().default(0),
    maybeSentAt: ts("maybe_sent_at"),
  },
  (t) => [
    unique().on(t.visitId, t.channel, t.attempt),
    check("outcome_unknown_only_failed", sql`not ${t.outcomeUnknown} or ${t.status} = 'failed'`),
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

// The one opt-out confirmation text (FR-8, Flow 2 step 4) as a durable outbox row, so a send whose outcome is unknown
// (a Twilio timeout) can be checked and retried by the optout-confirmations job (audit F-9-2). The recipient is read
// through the suppression row, so no customer phone is stored here; from_number is our own Twilio number.
// One row per suppression row: a retried webhook can never queue a second confirmation.
// status: sending (an attempt is in flight or its outcome is unknown), pending (the provider refused it, safe to
// resend), sent, provider (the provider confirmed it itself, 21610), expired (not sent within 5 minutes).
export const optOutConfirmations = pgTable(
  "optout_confirmations",
  {
    id: id(),
    suppressionId: uuid("suppression_id")
      .notNull()
      .unique()
      .references(() => suppressionList.id, { onDelete: "cascade" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
    fromNumber: text("from_number").notNull(),
    status: text("status").notNull().default("sending"),
    attempts: smallint("attempts").notNull().default(1),
    lastAttemptAt: ts("last_attempt_at").notNull().defaultNow(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("optout_confirmation_status", sql`${t.status} in ('sending', 'pending', 'sent', 'provider', 'expired')`),
    index().on(t.status),
  ],
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
    // Set when the sign-in link is used (single use): the hash of a fresh session secret, so the emailed link is never
    // itself the session credential.
    sessionTokenHash: text("session_token_hash").unique(),
    sessionExpiresAt: ts("session_expires_at"),
    revokedAt: ts("revoked_at"),
    // Set when the session was opened from a signed-in owner account (FR-24), so a password reset can end it.
    accountId: uuid("account_id").references(() => ownerAccounts.id, { onDelete: "cascade" }),
  },
  (t) => [
    unique().on(t.id, t.locationId),
    check("session_requires_token", sql`(${t.sessionTokenHash} is null) = (${t.sessionExpiresAt} is null)`),
  ],
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
    // When the draft was written: minutes to approve (audit) and the 48-hour overdue mark (Flow 3 step 5).
    createdAt: ts("created_at").notNull().defaultNow(),
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
    index().on(t.locationId, t.status), // the approval inbox lists a location's drafts by status
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

// Self-serve owner accounts (SPEC FR-24). One account per business in v0.1. Passwords are stored only as Argon2id
// hashes; emails, tokens and hashes are never logged.
export const accountTokenPurpose = pgEnum("account_token_purpose", ["verify_email", "reset_password"]);

export const ownerAccounts = pgTable("owner_accounts", {
  id: id(),
  businessId: uuid("business_id")
    .notNull()
    .unique()
    .references(() => businesses.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  normalizedEmail: text("normalized_email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  emailVerifiedAt: ts("email_verified_at"),
  termsVersion: text("terms_version").notNull(),
  termsAcceptedAt: ts("terms_accepted_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  disabledAt: ts("disabled_at"),
});

// Email verification (24 hours) and password reset (15 minutes) links: single use, only the hash is stored.
export const accountTokens = pgTable("account_tokens", {
  id: id(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => ownerAccounts.id, { onDelete: "cascade" }),
  purpose: accountTokenPurpose("purpose").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
});

// Signed-in owner accounts (30 days). The cookie holds a random secret; only its hash is stored.
export const accountSessions = pgTable("account_sessions", {
  id: id(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => ownerAccounts.id, { onDelete: "cascade" }),
  sessionTokenHash: text("session_token_hash").notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
});

// Operator sessions (SPEC Security: operator login uses a strong password plus two-factor authentication). One
// operator, configured by env (src/operator/auth.ts). totp_step is the authenticator-code time step that opened the
// session: unique, so a code is used once.
export const operatorSessions = pgTable("operator_sessions", {
  id: id(),
  sessionTokenHash: text("session_token_hash").notNull().unique(),
  totpStep: bigint("totp_step", { mode: "number" }).notNull().unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
});

// Rate-limit counter for sign-up, sign-in and reset. key is a SHA-256 of "<action>:<ip or email>", never the raw value.
export const authAttempts = pgTable(
  "auth_attempts",
  {
    id: id(),
    key: text("key").notNull(),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [index().on(t.key, t.at)],
);

// Landing-page waitlist: owners asking to be emailed back or let onto the platform. One row per email (a repeat
// updates it). No phone numbers, no review data.
export const waitlistEntries = pgTable("waitlist_entries", {
  id: id(),
  name: text("name").notNull(),
  businessName: text("business_name").notNull(),
  email: text("email").notNull(),
  normalizedEmail: text("normalized_email").notNull().unique(),
  mapsUrl: text("maps_url").notNull(),
  businessKind: text("business_kind").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// Hosted SMS opt-in page submissions (FR-23). Each row is a consent record by construction: a phone is stored only
// with the wording version shown, the time the customer checked the box, and the location whose business it names.
// Append-only evidence; deleted with the location. Not yet linked to customers (import still needs FR-3's fields).
export const smsOptIns = pgTable(
  "sms_opt_ins",
  {
    id: id(),
    locationId: uuid("location_id").notNull(),
    businessId: uuid("business_id").notNull(),
    normalizedPhone: text("normalized_phone").notNull(), // E.164
    consentWordingVersion: text("consent_wording_version").notNull(),
    consentAt: ts("consent_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "sms_opt_ins_location_fk",
      columns: [t.locationId, t.businessId],
      foreignColumns: [locations.id, locations.businessId],
    }).onDelete("cascade"),
    check("sms_opt_ins_phone_e164", sql`${t.normalizedPhone} ~ '^\\+1[2-9][0-9]{2}[2-9][0-9]{6}$'`),
    check("sms_opt_ins_wording_version", sql`length(${t.consentWordingVersion}) > 0`),
    index().on(t.locationId, t.normalizedPhone),
  ],
);
