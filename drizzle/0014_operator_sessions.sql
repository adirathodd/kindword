CREATE TABLE "operator_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_token_hash" text NOT NULL,
	"totp_step" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "operator_sessions_session_token_hash_unique" UNIQUE("session_token_hash"),
	CONSTRAINT "operator_sessions_totp_step_unique" UNIQUE("totp_step")
);
