-- oxy:deploy-phase=pre
CREATE TABLE "clarity_search_hosts" (
	"host" text PRIMARY KEY NOT NULL,
	"icon_status" text DEFAULT 'pending' NOT NULL,
	"icon_hint_url" text,
	"icon_source_url" text,
	"icon_content_type" text,
	"icon_bytes" "bytea",
	"icon_fetched_at" timestamp with time zone,
	"icon_next_fetch_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_search_hosts_icon_status_check" CHECK ("clarity_search_hosts"."icon_status" in ('pending', 'ready', 'missing')),
	CONSTRAINT "clarity_search_hosts_icon_ready_check" CHECK ("clarity_search_hosts"."icon_status" <> 'ready' or ("clarity_search_hosts"."icon_bytes" is not null and "clarity_search_hosts"."icon_content_type" is not null))
);
--> statement-breakpoint
CREATE INDEX "clarity_search_hosts_icon_due_idx" ON "clarity_search_hosts" USING btree ("icon_next_fetch_at");