-- oxy:deploy-phase=pre
--
-- Two partial indexes for the worker's sweeps, and autovacuum thresholds for the
-- crawl table those sweeps read through. Purely additive: both images issue the
-- same queries; the old one just gets cheaper plans.
--
-- * clarity_crawl_pages_fetching_lease_idx — `status = 'fetching'` only: the
--   expired-lease recovery and each claim's per-owner concurrency count
--   (worker.ts `recoverExpiredLeases`, `leaseNextPage`). They read it through
--   `clarity_crawl_pages_priority_idx`, where every page that WAS fetching
--   leaves a dead entry under `fetching` until vacuum: on the fresh PlanetScale
--   copy the recovery read 2,861 buffers to find 0 rows (2026-11-28). Holds only
--   the live leases (8 rows at the time).
-- * clarity_job_postings_active_valid_through_idx — the lifecycle sweep's
--   expiry (search/jobs/lifecycle.ts): through the unpartial
--   `clarity_job_postings_valid_through_idx` it walked 100k listings past their
--   date, nearly all already expired, stale or closed, to find 4 — 91k buffers,
--   10.9 s cold, every 15 minutes.
-- * clarity_crawl_pages autovacuum: 5.2M rows, so the default 20% scale factor
--   let ~1M dead versions build up before a vacuum, and lease churn (every
--   claim and completion moves `status`, an indexed column, so none is HOT)
--   leaves its dead index entries exactly where the sweeps look. 1% + 1000.
--   A storage parameter: SHARE UPDATE EXCLUSIVE, no rewrite.
--
-- ## LOCKS
--
-- Both tables are written by every crawl and feed poll. A plain CREATE INDEX
-- holds SHARE for the build: reads continue, those writes block. The migrator
-- runs each migration in a transaction, where CONCURRENTLY is impossible, so in
-- production build both OUT OF BAND first, from a one-shot, outside any
-- transaction, and let this migration find the work done —
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS clarity_crawl_pages_fetching_lease_idx ON clarity_crawl_pages USING btree (lease_expires_at, job_id) WHERE status = 'fetching';
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS clarity_job_postings_active_valid_through_idx ON clarity_job_postings USING btree (valid_through) WHERE status = 'active' AND valid_through IS NOT NULL;
--   SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname IN ('clarity_crawl_pages_fetching_lease_idx', 'clarity_job_postings_active_valid_through_idx');  -- two rows, both t
--
-- Not during the PlanetScale migration's schema freeze: DDL does not replicate.
-- A failed CREATE INDEX CONCURRENTLY leaves an INVALID index under the same
-- name, which `IF NOT EXISTS` would silently accept; the guard refuses it.
CREATE INDEX IF NOT EXISTS "clarity_crawl_pages_fetching_lease_idx" ON "clarity_crawl_pages" USING btree ("lease_expires_at","job_id") WHERE "clarity_crawl_pages"."status" = 'fetching';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clarity_job_postings_active_valid_through_idx" ON "clarity_job_postings" USING btree ("valid_through") WHERE "clarity_job_postings"."status" = 'active' and "clarity_job_postings"."valid_through" is not null;--> statement-breakpoint
ALTER TABLE "clarity_crawl_pages" SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 1000);--> statement-breakpoint
DO $$
DECLARE
  invalid text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO invalid
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relname IN ('clarity_crawl_pages_fetching_lease_idx', 'clarity_job_postings_active_valid_through_idx')
    AND NOT i.indisvalid;
  IF invalid IS NOT NULL THEN
    RAISE EXCEPTION 'sweep partial index not valid: %. A CREATE INDEX CONCURRENTLY failed part-way; DROP INDEX CONCURRENTLY it and build it again before migrating.', invalid;
  END IF;
END $$;
