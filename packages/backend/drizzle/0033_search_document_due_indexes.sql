-- oxy:deploy-phase=pre
-- The two sweeps that ask the documents table "what is due?" read the whole
-- table on every run, because neither predicate was indexed:
--
--  * `enqueueJobRecrawls` (worker): job documents whose `next_fetch_at` has
--    passed. With nothing due, its LIMIT never stops the scan early.
--  * the news feed's candidates (`singleArticleStories`): recent indexed news,
--    newest first by `coalesce(published_at, indexed_at)`.
--
-- Measured in production (2026-10-17, pg_stat_user_tables deltas and EXPLAIN):
-- a Seq Scan of ~1.1M rows each, two every five minutes, ~323k blocks read from
-- disk per five minutes — about 1,080 of the clarity database's ~2,990 block
-- reads a second on the shared, I/O-bound instance.
--
-- Both indexes are partial on exactly the rows the sweep reads, so they are
-- small (the job one covers ~800k rows, the news one ~49k) and an equality or
-- range on their key implies the predicate.
--
-- Same shape as 0026: the transactional migrator cannot run CONCURRENTLY, so
-- the indexes are built CONCURRENTLY by hand ahead of a production deploy and
-- IF NOT EXISTS lets this pass over them; a fresh install builds them here.
-- Refuse after 5s acquiring locks or 120s building rather than stall writes.
SELECT set_config('clarity.due_index_lock_timeout', current_setting('lock_timeout'), true),
       set_config('clarity.due_index_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clarity_search_documents_job_recrawl_due_idx" ON "clarity_search_documents" USING btree ("next_fetch_at") WHERE "clarity_search_documents"."document_type" = 'job' and "clarity_search_documents"."status" = 'indexed' and "clarity_search_documents"."next_fetch_at" is not null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clarity_search_documents_news_recent_idx" ON "clarity_search_documents" USING btree ((coalesce("published_at", "indexed_at")) desc nulls last) WHERE "clarity_search_documents"."document_type" = 'news' and "clarity_search_documents"."status" = 'indexed' and "clarity_search_documents"."noindex" = false;
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('clarity.due_index_lock_timeout'), true),
       set_config('statement_timeout', current_setting('clarity.due_index_statement_timeout'), true);
