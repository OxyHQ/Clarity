-- oxy:deploy-phase=pre
-- A document is found by any URL it answered to: `fetchedDocuments` (every
-- `/v1/resolve`, twice when the caller waits), the worker's
-- `completeIfAlreadyFetched` (every resolve page it claims) and
-- `recordGoneDocument` all match `canonical_url OR requested_url OR final_url`.
-- Only `canonical_url` was indexed, so every one of them was a parallel
-- sequential scan of the whole table. Measured in production (Performance
-- Insights and EXPLAIN ANALYZE, 2026-10-15): ~126k shared buffers and
-- ~180-230 ms per call, ~1.8 calls a second, 0.9 average active sessions —
-- about half of the shared instance's two vCPUs.
--
-- With all three indexed the OR is a BitmapOr of three index probes. Only a
-- redirected fetch records a final URL (~30% of rows), so that index is
-- partial; an equality on the column implies the predicate.
--
-- This uses the existing transactional migrator: CONCURRENTLY is unavailable.
-- CREATE INDEX takes SHARE: reads continue, writes wait until the transaction
-- commits. Refuse after 5s acquiring locks or 60s building, rather than create
-- an unbounded write stall. A failure rolls back the indexes and ledger entry.
-- A read-only sort of the same column over the same ~860k rows took 5.8s in
-- production. IF NOT EXISTS so that the indexes can be built CONCURRENTLY by
-- hand ahead of the deploy and the migration passes over them.
-- Preserve the connection settings for any later migration in this transaction.
SELECT set_config('clarity.document_url_lock_timeout', current_setting('lock_timeout'), true),
       set_config('clarity.document_url_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clarity_search_documents_requested_url_idx" ON "clarity_search_documents" USING btree ("requested_url");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clarity_search_documents_final_url_idx" ON "clarity_search_documents" USING btree ("final_url") WHERE "clarity_search_documents"."final_url" is not null;
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('clarity.document_url_lock_timeout'), true),
       set_config('statement_timeout', current_setting('clarity.document_url_statement_timeout'), true);
