CREATE TABLE "job_runs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	"last_result" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "channel" NOT NULL,
	"provider_message_id" text NOT NULL,
	"status" text NOT NULL,
	"error_code" integer,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_receipts_channel_provider_message_id_status_unique" UNIQUE("channel","provider_message_id","status"),
	CONSTRAINT "pending_receipt_status" CHECK ("pending_receipts"."status" in ('delivered', 'undelivered', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "pending_receipts_received_at_index" ON "pending_receipts" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "review_requests_provider_message_id_index" ON "review_requests" USING btree ("provider_message_id");