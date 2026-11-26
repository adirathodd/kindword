ALTER TABLE "review_requests" ADD COLUMN "send_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_requests" ADD COLUMN "maybe_sent_at" timestamp with time zone;