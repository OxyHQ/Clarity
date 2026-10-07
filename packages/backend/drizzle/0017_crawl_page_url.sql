-- oxy:deploy-phase=pre
CREATE INDEX "clarity_crawl_pages_url_status_idx" ON "clarity_crawl_pages" USING btree ("url","status");