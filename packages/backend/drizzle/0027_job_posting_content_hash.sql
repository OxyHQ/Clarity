-- oxy:deploy-phase=pre
-- A feed re-delivers every live listing on every poll, and each delivery
-- rewrote the whole clarity_job_postings row: a ~10 KB row whose description,
-- evidence and search vector live in TOAST, so every re-observation wrote a new
-- heap tuple, new TOAST chunks and a new entry in all fifteen indexes, and left
-- the old ones for vacuum. Measured in production (pg_stat_user_tables,
-- 2026-10-15): 24.6M updates against 0.88M rows (10% HOT), 8.6M TOAST inserts,
-- and autovacuum of the table and its TOAST the top two load items on the
-- shared instance.
--
-- content_hash fingerprints what the projection stores apart from the sighting,
-- so an unchanged listing only records last_seen_at and its status. Existing
-- rows have none; each is written in full once more on its next sighting.
--
-- Adding a nullable column without a default is a catalogue change, but it
-- takes ACCESS EXCLUSIVE: refuse after 5s waiting for the lock rather than
-- queue every reader of the table behind it. A failure rolls back the column
-- and the ledger entry.
-- Preserve the connection settings for any later migration in this transaction.
SELECT set_config('clarity.job_content_hash_lock_timeout', current_setting('lock_timeout'), true),
       set_config('clarity.job_content_hash_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
ALTER TABLE "clarity_job_postings" ADD COLUMN IF NOT EXISTS "content_hash" text;
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('clarity.job_content_hash_lock_timeout'), true),
       set_config('statement_timeout', current_setting('clarity.job_content_hash_statement_timeout'), true);
