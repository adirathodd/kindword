CREATE TABLE "waitlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"business_name" text NOT NULL,
	"email" text NOT NULL,
	"normalized_email" text NOT NULL,
	"maps_url" text NOT NULL,
	"business_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_entries_normalized_email_unique" UNIQUE("normalized_email")
);
