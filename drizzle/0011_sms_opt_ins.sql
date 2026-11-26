CREATE TABLE "sms_opt_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"normalized_phone" text NOT NULL,
	"consent_wording_version" text NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sms_opt_ins_phone_e164" CHECK ("sms_opt_ins"."normalized_phone" ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
	CONSTRAINT "sms_opt_ins_wording_version" CHECK (length("sms_opt_ins"."consent_wording_version") > 0)
);
--> statement-breakpoint
ALTER TABLE "sms_opt_ins" ADD CONSTRAINT "sms_opt_ins_location_fk" FOREIGN KEY ("location_id","business_id") REFERENCES "public"."locations"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sms_opt_ins_location_id_normalized_phone_index" ON "sms_opt_ins" USING btree ("location_id","normalized_phone");