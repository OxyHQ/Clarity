-- oxy:deploy-phase=pre
ALTER TABLE "clarity_crawl_jobs" ADD COLUMN "caller_tier" text DEFAULT 'external' NOT NULL;--> statement-breakpoint
ALTER TABLE "clarity_crawl_jobs" ADD CONSTRAINT "clarity_crawl_jobs_caller_tier_check" CHECK ("clarity_crawl_jobs"."caller_tier" in ('internal', 'external'));