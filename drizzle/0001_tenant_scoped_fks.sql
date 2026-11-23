ALTER TABLE "customers" DROP CONSTRAINT "customers_location_id_locations_id_fk";--> statement-breakpoint
ALTER TABLE "customers" DROP CONSTRAINT "customers_attestation_id_consent_attestations_id_fk";--> statement-breakpoint
ALTER TABLE "reply_drafts" DROP CONSTRAINT "reply_drafts_review_id_reviews_id_fk";--> statement-breakpoint
ALTER TABLE "reply_drafts" DROP CONSTRAINT "reply_drafts_approved_session_id_owner_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "business_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD COLUMN "location_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_attestations" ADD CONSTRAINT "consent_attestations_id_business_id_unique" UNIQUE("id","business_id");--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_id_business_id_unique" UNIQUE("id","business_id");--> statement-breakpoint
ALTER TABLE "owner_sessions" ADD CONSTRAINT "owner_sessions_id_location_id_unique" UNIQUE("id","location_id");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_id_location_id_unique" UNIQUE("id","location_id");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_location_fk" FOREIGN KEY ("location_id","business_id") REFERENCES "public"."locations"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_attestation_fk" FOREIGN KEY ("attestation_id","business_id") REFERENCES "public"."consent_attestations"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_review_fk" FOREIGN KEY ("review_id","location_id") REFERENCES "public"."reviews"("id","location_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_session_fk" FOREIGN KEY ("approved_session_id","location_id") REFERENCES "public"."owner_sessions"("id","location_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD CONSTRAINT "approved_requires_session" CHECK ("reply_drafts"."approved_at" is null or "reply_drafts"."approved_session_id" is not null);
