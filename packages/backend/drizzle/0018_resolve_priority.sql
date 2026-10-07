-- oxy:deploy-phase=pre
ALTER TABLE "clarity_crawl_pages" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "clarity_crawl_pages_priority_idx" ON "clarity_crawl_pages" USING btree ("status","priority" DESC NULLS LAST,"available_at","lease_expires_at");