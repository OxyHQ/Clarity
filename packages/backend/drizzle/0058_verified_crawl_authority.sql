-- oxy:deploy-phase=pre
-- Preserve old job metadata; historical caller_tier is never workload proof.
-- Shared sessions get account rate buckets, not a fabricated application id.
ALTER TABLE "clarity_search_rate_limit_buckets" DROP CONSTRAINT "clarity_search_rate_limit_buckets_dimension_check";--> statement-breakpoint
ALTER TABLE "clarity_crawl_jobs" ADD COLUMN "caller_authority" text DEFAULT 'external' NOT NULL;--> statement-breakpoint
ALTER TABLE "clarity_crawl_jobs" ADD COLUMN "caller_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "clarity_search_usage_events" ADD COLUMN "caller_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "clarity_crawl_jobs" ADD CONSTRAINT "clarity_crawl_jobs_caller_authority_check" CHECK ("clarity_crawl_jobs"."caller_authority" in ('first_party', 'external'));--> statement-breakpoint
ALTER TABLE "clarity_search_rate_limit_buckets" ADD CONSTRAINT "clarity_search_rate_limit_buckets_dimension_check" CHECK ("clarity_search_rate_limit_buckets"."dimension" in ('credential', 'application', 'account'));
