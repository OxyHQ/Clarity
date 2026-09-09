-- oxy:deploy-phase=pre
CREATE TABLE "clarity_job_feeds" (
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
	"listings_seen" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_job_feeds_kind_identifier_unique" UNIQUE("kind","identifier"),
	CONSTRAINT "clarity_job_feeds_kind_check" CHECK ("clarity_job_feeds"."kind" in ('greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'remoteok', 'remotive', 'arbeitnow', 'rss')),
	CONSTRAINT "clarity_job_feeds_status_check" CHECK ("clarity_job_feeds"."last_status" is null or "clarity_job_feeds"."last_status" in ('ok', 'error')),
	CONSTRAINT "clarity_job_feeds_interval_check" CHECK ("clarity_job_feeds"."poll_interval_seconds" >= 900),
	CONSTRAINT "clarity_job_feeds_listings_check" CHECK ("clarity_job_feeds"."listings_seen" >= 0)
);
--> statement-breakpoint
ALTER TABLE "clarity_job_postings" DROP CONSTRAINT "clarity_job_postings_source_type_check";--> statement-breakpoint
CREATE INDEX "clarity_job_feeds_due_idx" ON "clarity_job_feeds" USING btree ("enabled","next_poll_at");--> statement-breakpoint
ALTER TABLE "clarity_job_postings" ADD CONSTRAINT "clarity_job_postings_source_type_check" CHECK ("clarity_job_postings"."source_type" in ('web', 'verified_site', 'first_party', 'feed'));