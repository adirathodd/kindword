ALTER TABLE "locations" ADD COLUMN "sms_number" text;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_sms_number_unique" UNIQUE("sms_number");