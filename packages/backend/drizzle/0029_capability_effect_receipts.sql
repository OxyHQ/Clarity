-- oxy:deploy-phase=pre
CREATE TABLE "clarity_capability_effect_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"tool" text NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"input_digest" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "clarity_capability_effect_receipts_key_unique" UNIQUE("oxy_user_id","tool","idempotency_key_hash"),
	CONSTRAINT "clarity_capability_effect_receipts_status_check" CHECK ("clarity_capability_effect_receipts"."status" in ('pending', 'completed')),
	CONSTRAINT "clarity_capability_effect_receipts_completed_check" CHECK (("clarity_capability_effect_receipts"."status" = 'completed') = ("clarity_capability_effect_receipts"."completed_at" is not null and "clarity_capability_effect_receipts"."result" is not null))
);
--> statement-breakpoint
CREATE INDEX "clarity_capability_effect_receipts_expires_idx" ON "clarity_capability_effect_receipts" USING btree ("expires_at");