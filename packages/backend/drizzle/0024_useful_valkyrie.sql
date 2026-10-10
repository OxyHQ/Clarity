-- oxy:deploy-phase=pre
CREATE INDEX "clarity_crawl_pages_claim_idx" ON "clarity_crawl_pages" USING btree ("priority" DESC NULLS LAST,"available_at","created_at","id") WHERE "clarity_crawl_pages"."status" in ('queued', 'retry');
