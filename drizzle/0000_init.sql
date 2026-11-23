CREATE TYPE "public"."business_status" AS ENUM('onboarding', 'live', 'paused', 'offboarded');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('sms', 'email');--> statement-breakpoint
CREATE TYPE "public"."consent_method" AS ENUM('signed_estimate', 'web_form', 'booking_form');--> statement-breakpoint
CREATE TYPE "public"."draft_status" AS ENUM('draft', 'awaiting_owner', 'held', 'approved', 'rejected', 'posted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."oauth_status" AS ENUM('active', 'refresh_failed', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('scheduled', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."skip_reason" AS ENUM('stale', 'opted_out', 'no_consent', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."visit_source" AS ENUM('csv', 'sheet');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid,
	"entity" text NOT NULL,
	"entity_id" uuid,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"detail" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"vertical" text NOT NULL,
	"owner_name" text,
	"owner_phone" text,
	"owner_email" text,
	"owner_contact_consent_ref" text,
	"languages" text[] DEFAULT '{en}'::text[] NOT NULL,
	"tone_notes" text,
	"status" "business_status" DEFAULT 'onboarding' NOT NULL,
	CONSTRAINT "owner_phone_requires_consent" CHECK ("businesses"."owner_phone" is null or "businesses"."owner_contact_consent_ref" is not null)
);
--> statement-breakpoint
CREATE TABLE "consent_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"document_ref" text NOT NULL,
	"list_description" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text,
	"phone" text,
	"email" text,
	"normalized_phone" text,
	"normalized_email" text,
	"language" text,
	"consent_method" "consent_method",
	"consent_wording_version" text,
	"consent_at" timestamp with time zone,
	"consent_evidence_ref" text,
	"attestation_id" uuid,
	"opted_out_at" timestamp with time zone,
	CONSTRAINT "customers_location_id_normalized_phone_unique" UNIQUE("location_id","normalized_phone"),
	CONSTRAINT "customers_location_id_normalized_email_unique" UNIQUE("location_id","normalized_email"),
	CONSTRAINT "phone_requires_consent" CHECK (("customers"."phone" is null and "customers"."normalized_phone" is null) or (
        "customers"."consent_method" is not null and "customers"."consent_wording_version" is not null and
        "customers"."consent_at" is not null and "customers"."consent_evidence_ref" is not null and "customers"."attestation_id" is not null)),
	CONSTRAINT "phone_normalized" CHECK (("customers"."phone" is null) = ("customers"."normalized_phone" is null)),
	CONSTRAINT "email_normalized" CHECK (("customers"."email" is null) = ("customers"."normalized_email" is null)),
	CONSTRAINT "has_contact" CHECK ("customers"."phone" is not null or "customers"."email" is not null)
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"review_link" text NOT NULL,
	"google_location_id" text,
	"google_connected_at" timestamp with time zone,
	CONSTRAINT "locations_google_location_id_unique" UNIQUE("google_location_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"encrypted_refresh_token" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"status" "oauth_status" DEFAULT 'active' NOT NULL,
	CONSTRAINT "oauth_tokens_location_id_unique" UNIQUE("location_id")
);
--> statement-breakpoint
CREATE TABLE "owner_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"owner_email" text NOT NULL,
	"login_token_hash" text NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"session_expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "owner_sessions_login_token_hash_unique" UNIQUE("login_token_hash")
);
--> statement-breakpoint
CREATE TABLE "reply_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"draft_text" text NOT NULL,
	"final_text" text,
	"status" "draft_status" DEFAULT 'draft' NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"approved_session_id" uuid,
	"approved_at" timestamp with time zone,
	"posted_at" timestamp with time zone,
	CONSTRAINT "posted_requires_approval" CHECK ("reply_drafts"."posted_at" is null or "reply_drafts"."approved_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "review_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visit_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"channel" "channel" NOT NULL,
	"status" "request_status" DEFAULT 'scheduled' NOT NULL,
	"skip_reason" "skip_reason",
	"provider_message_id" text,
	"attempt" smallint NOT NULL,
	"clicked_at" timestamp with time zone,
	CONSTRAINT "review_requests_visit_id_channel_attempt_unique" UNIQUE("visit_id","channel","attempt"),
	CONSTRAINT "attempt_1_or_2" CHECK ("review_requests"."attempt" in (1, 2)),
	CONSTRAINT "skip_reason_iff_skipped" CHECK (("review_requests"."status" = 'skipped') = ("review_requests"."skip_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"google_review_id" text NOT NULL,
	"rating" smallint NOT NULL,
	"text" text,
	"reviewer_name" text,
	"language" text,
	"posted_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"has_reply" boolean DEFAULT false NOT NULL,
	CONSTRAINT "reviews_google_review_id_unique" UNIQUE("google_review_id"),
	CONSTRAINT "rating_1_to_5" CHECK ("reviews"."rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "sheet_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"sheet_id" text NOT NULL,
	"last_row_id" text,
	"last_read_at" timestamp with time zone,
	CONSTRAINT "sheet_sources_location_id_unique" UNIQUE("location_id")
);
--> statement-breakpoint
CREATE TABLE "suppression_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid,
	"channel" "channel" NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "suppression_list_location_id_channel_address_unique" UNIQUE NULLS NOT DISTINCT("location_id","channel","address")
);
--> statement-breakpoint
CREATE TABLE "visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"visit_at" timestamp with time zone NOT NULL,
	"source" "visit_source" NOT NULL,
	"external_visit_id" text NOT NULL,
	CONSTRAINT "visits_location_id_source_external_visit_id_unique" UNIQUE("location_id","source","external_visit_id")
);
--> statement-breakpoint
ALTER TABLE "consent_attestations" ADD CONSTRAINT "consent_attestations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_attestation_id_consent_attestations_id_fk" FOREIGN KEY ("attestation_id") REFERENCES "public"."consent_attestations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_sessions" ADD CONSTRAINT "owner_sessions_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_approved_session_id_owner_sessions_id_fk" FOREIGN KEY ("approved_session_id") REFERENCES "public"."owner_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_sources" ADD CONSTRAINT "sheet_sources_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_list" ADD CONSTRAINT "suppression_list_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_location_id_at_index" ON "audit_log" USING btree ("location_id","at");--> statement-breakpoint
CREATE INDEX "locations_business_id_index" ON "locations" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_posted_reply_per_review" ON "reply_drafts" USING btree ("review_id") WHERE "reply_drafts"."status" = 'posted';--> statement-breakpoint
CREATE INDEX "review_requests_status_scheduled_for_index" ON "review_requests" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "reviews_fetched_at_index" ON "reviews" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "suppression_list_channel_address_index" ON "suppression_list" USING btree ("channel","address");--> statement-breakpoint
CREATE INDEX "visits_customer_id_index" ON "visits" USING btree ("customer_id");