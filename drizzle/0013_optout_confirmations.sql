CREATE TABLE "optout_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suppression_id" uuid NOT NULL,
	"location_id" uuid,
	"from_number" text NOT NULL,
	"status" text DEFAULT 'sending' NOT NULL,
	"attempts" smallint DEFAULT 1 NOT NULL,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "optout_confirmations_suppression_id_unique" UNIQUE("suppression_id"),
	CONSTRAINT "optout_confirmation_status" CHECK ("optout_confirmations"."status" in ('sending', 'pending', 'sent', 'provider', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "optout_confirmations" ADD CONSTRAINT "optout_confirmations_suppression_id_suppression_list_id_fk" FOREIGN KEY ("suppression_id") REFERENCES "public"."suppression_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optout_confirmations" ADD CONSTRAINT "optout_confirmations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "optout_confirmations_status_index" ON "optout_confirmations" USING btree ("status");