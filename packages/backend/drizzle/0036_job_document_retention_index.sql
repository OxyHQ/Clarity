-- oxy:deploy-phase=pre
-- Job retention (`pruneInactiveJobDocuments`, every 15 minutes) asks for job
-- documents whose retention clock, `coalesce(fetched_at, updated_at)`, is older
-- than 90 days and none of whose listings is still live. With nothing indexing
-- that clock, the planner answered it by hashing every listing: a parallel
-- sequential scan of all ~1M rows of clarity_job_postings (and a scan of the
-- job documents) on every pass.
--
-- Measured in production (2026-10-17): ~1,024 block reads a second from the
-- postings table during a 4-minute sample, the largest single reader on the
-- shared, I/O-bound instance once the semantic index was halved — and the pass
-- found nothing, because no job document is 90 days old yet.
--
-- This partial index holds the clock for job documents only, so the pass reads
-- the expired candidates oldest first and checks only those against their
-- listings (an index probe each, `clarity_job_postings_document_source_unique`).
--
-- Same shape as 0026/0033: built CONCURRENTLY by hand in production ahead of
-- the deploy, IF NOT EXISTS here; a fresh install builds it inline.
SELECT set_config('clarity.retention_index_lock_timeout', current_setting('lock_timeout'), true),
       set_config('clarity.retention_index_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clarity_search_documents_job_retention_idx" ON "clarity_search_documents" USING btree ((coalesce("fetched_at", "updated_at"))) WHERE "clarity_search_documents"."document_type" = 'job';
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('clarity.retention_index_lock_timeout'), true),
       set_config('statement_timeout', current_setting('clarity.retention_index_statement_timeout'), true);
