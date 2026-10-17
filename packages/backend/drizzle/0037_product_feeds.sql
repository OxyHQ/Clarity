-- oxy:deploy-phase=pre
-- Product feeds: the public shop catalogues Clarity polls, and the source document of each
-- product they list (docs/product-feeds.mdx). Additive: two new tables nothing reads yet.
CREATE TABLE "clarity_product_feed_records" (
	"feed_id" text NOT NULL,
	"external_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "clarity_product_feed_records_feed_id_external_id_pk" PRIMARY KEY("feed_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "clarity_product_feeds" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"identifier" text NOT NULL,
	"label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"poll_interval_seconds" integer DEFAULT 21600 NOT NULL,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"meta" jsonb,
	"cursor" text,
	"walk_started_at" timestamp with time zone,
	"last_completed_at" timestamp with time zone,
	"records_seen" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_product_feeds_kind_identifier_unique" UNIQUE("kind","identifier"),
	CONSTRAINT "clarity_product_feeds_kind_check" CHECK ("clarity_product_feeds"."kind" in ('shopify_storefront', 'steam_store')),
	CONSTRAINT "clarity_product_feeds_status_check" CHECK ("clarity_product_feeds"."last_status" is null or "clarity_product_feeds"."last_status" in ('ok', 'error')),
	CONSTRAINT "clarity_product_feeds_interval_check" CHECK ("clarity_product_feeds"."poll_interval_seconds" >= 3600),
	CONSTRAINT "clarity_product_feeds_records_check" CHECK ("clarity_product_feeds"."records_seen" >= 0)
);
--> statement-breakpoint
ALTER TABLE "clarity_product_feed_records" ADD CONSTRAINT "clarity_product_feed_records_feed_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."clarity_product_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clarity_product_feed_records_seen_idx" ON "clarity_product_feed_records" USING btree ("feed_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "clarity_product_feeds_due_idx" ON "clarity_product_feeds" USING btree ("enabled","next_poll_at");