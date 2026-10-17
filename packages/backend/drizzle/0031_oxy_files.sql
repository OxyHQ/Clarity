-- oxy:deploy-phase=pre
-- ADR 0043 stage 4: Clarity's remote images become Clarity-owned Oxy files.
-- Additive only: new tables, two nullable file-id columns, and CHECKs widened
-- to admit an Oxy-held image (no bytes) and the `blocked` status. The legacy
-- byte columns stay until the storage-retirement step (docs/oxy-files.md).
CREATE TABLE "clarity_image_references" (
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"oxy_file_id" text NOT NULL,
	"image_key" text,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_image_references_entity_type_entity_id_pk" PRIMARY KEY("entity_type","entity_id"),
	CONSTRAINT "clarity_image_references_entity_type_check" CHECK ("clarity_image_references"."entity_type" in ('search_document', 'job_posting', 'search_host')),
	CONSTRAINT "clarity_image_references_image_key_check" CHECK (("clarity_image_references"."entity_type" = 'search_host') = ("clarity_image_references"."image_key" is null))
);
--> statement-breakpoint
CREATE TABLE "clarity_legacy_image_reads" (
	"day" date NOT NULL,
	"surface" text NOT NULL,
	"reads" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "clarity_legacy_image_reads_day_surface_pk" PRIMARY KEY("day","surface"),
	CONSTRAINT "clarity_legacy_image_reads_surface_check" CHECK ("clarity_legacy_image_reads"."surface" in ('images', 'favicons', 'favicons_svg'))
);
--> statement-breakpoint
CREATE TABLE "clarity_oxy_file_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"oxy_file_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clarity_oxy_file_jobs" (
	"name" text PRIMARY KEY NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_until" timestamp with time zone,
	"last_result" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clarity_oxy_file_reference_outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "clarity_oxy_file_reference_outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"op" text NOT NULL,
	"oxy_file_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_oxy_file_reference_outbox_op_check" CHECK ("clarity_oxy_file_reference_outbox"."op" in ('add', 'remove'))
);
--> statement-breakpoint
ALTER TABLE "clarity_image_cache" DROP CONSTRAINT "clarity_image_cache_status_check";--> statement-breakpoint
ALTER TABLE "clarity_image_cache" DROP CONSTRAINT "clarity_image_cache_ready_check";--> statement-breakpoint
ALTER TABLE "clarity_search_hosts" DROP CONSTRAINT "clarity_search_hosts_icon_status_check";--> statement-breakpoint
ALTER TABLE "clarity_search_hosts" DROP CONSTRAINT "clarity_search_hosts_icon_ready_check";--> statement-breakpoint
ALTER TABLE "clarity_image_cache" ADD COLUMN "oxy_file_id" text;--> statement-breakpoint
ALTER TABLE "clarity_search_hosts" ADD COLUMN "icon_oxy_file_id" text;--> statement-breakpoint
ALTER TABLE "clarity_image_references" ADD CONSTRAINT "clarity_image_references_image_key_clarity_image_cache_key_fk" FOREIGN KEY ("image_key") REFERENCES "public"."clarity_image_cache"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clarity_image_references_file_idx" ON "clarity_image_references" USING btree ("oxy_file_id");--> statement-breakpoint
CREATE INDEX "clarity_image_references_image_key_idx" ON "clarity_image_references" USING btree ("image_key") WHERE "clarity_image_references"."image_key" is not null;--> statement-breakpoint
CREATE INDEX "clarity_image_references_last_used_idx" ON "clarity_image_references" USING btree ("last_used_at");--> statement-breakpoint
CREATE INDEX "clarity_image_cache_oxy_file_idx" ON "clarity_image_cache" USING btree ("oxy_file_id") WHERE "clarity_image_cache"."oxy_file_id" is not null;--> statement-breakpoint
CREATE INDEX "clarity_image_cache_legacy_idx" ON "clarity_image_cache" USING btree ("key") WHERE "clarity_image_cache"."bytes" is not null;--> statement-breakpoint
CREATE INDEX "clarity_search_hosts_icon_oxy_file_idx" ON "clarity_search_hosts" USING btree ("icon_oxy_file_id") WHERE "clarity_search_hosts"."icon_oxy_file_id" is not null;--> statement-breakpoint
ALTER TABLE "clarity_image_cache" ADD CONSTRAINT "clarity_image_cache_blocked_check" CHECK ("clarity_image_cache"."status" <> 'blocked' or "clarity_image_cache"."oxy_file_id" is not null);--> statement-breakpoint
ALTER TABLE "clarity_image_cache" ADD CONSTRAINT "clarity_image_cache_status_check" CHECK ("clarity_image_cache"."status" in ('ready', 'missing', 'blocked'));--> statement-breakpoint
ALTER TABLE "clarity_image_cache" ADD CONSTRAINT "clarity_image_cache_ready_check" CHECK ("clarity_image_cache"."status" <> 'ready' or "clarity_image_cache"."oxy_file_id" is not null or ("clarity_image_cache"."bytes" is not null and "clarity_image_cache"."content_type" is not null));--> statement-breakpoint
ALTER TABLE "clarity_search_hosts" ADD CONSTRAINT "clarity_search_hosts_icon_status_check" CHECK ("clarity_search_hosts"."icon_status" in ('pending', 'ready', 'missing', 'blocked'));--> statement-breakpoint
ALTER TABLE "clarity_search_hosts" ADD CONSTRAINT "clarity_search_hosts_icon_ready_check" CHECK ("clarity_search_hosts"."icon_status" <> 'ready' or ("clarity_search_hosts"."icon_content_type" is not null and ("clarity_search_hosts"."icon_bytes" is not null or "clarity_search_hosts"."icon_oxy_file_id" is not null)));