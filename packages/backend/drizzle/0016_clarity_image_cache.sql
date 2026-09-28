-- oxy:deploy-phase=pre
CREATE TABLE "clarity_image_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"source_url" text NOT NULL,
	"status" text NOT NULL,
	"content_type" text,
	"bytes" "bytea",
	"byte_size" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_image_cache_status_check" CHECK ("clarity_image_cache"."status" in ('ready', 'missing')),
	CONSTRAINT "clarity_image_cache_ready_check" CHECK ("clarity_image_cache"."status" <> 'ready' or ("clarity_image_cache"."bytes" is not null and "clarity_image_cache"."content_type" is not null))
);
--> statement-breakpoint
CREATE INDEX "clarity_image_cache_last_accessed_idx" ON "clarity_image_cache" USING btree ("last_accessed_at");