-- oxy:deploy-phase=post
-- The first of three steps that make `code` and `model` NOT NULL without
-- scanning the 4 GiB table under ACCESS EXCLUSIVE: a CHECK added NOT VALID
-- (no scan; enforced on every write from here on), validated by 0066 under
-- SHARE UPDATE EXCLUSIVE, which lets reads and writes through, and then
-- `SET NOT NULL` in 0067, which PostgreSQL proves from the valid check instead
-- of scanning.
--
-- ACCESS EXCLUSIVE for the moment the catalogue changes. Refuse after 2s
-- waiting for it (the migrator retries with backoff) rather than queue every
-- search behind it. The wait cancels a running autovacuum of the table, which
-- runs again once the deploy is done.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "clarity_search_chunk_embeddings" ADD CONSTRAINT "clarity_search_chunk_embeddings_code_not_null" CHECK ("code" IS NOT NULL AND "model" IS NOT NULL) NOT VALID;
