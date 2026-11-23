ALTER TABLE "owner_sessions" ADD COLUMN "session_token_hash" text;--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "reply_drafts_location_id_status_index" ON "reply_drafts" USING btree ("location_id","status");--> statement-breakpoint
ALTER TABLE "owner_sessions" ADD CONSTRAINT "owner_sessions_session_token_hash_unique" UNIQUE("session_token_hash");--> statement-breakpoint
ALTER TABLE "owner_sessions" ADD CONSTRAINT "session_requires_token" CHECK (("owner_sessions"."session_token_hash" is null) = ("owner_sessions"."session_expires_at" is null));