-- oxy:deploy-phase=post
-- A listing that arrived by ingest (a feed, or a publisher's API submission)
-- was given a recrawl date it could never meet: `enqueueJobRecrawls` only
-- re-queues a URL some crawl page fetched, and an ingested listing has none —
-- its source re-observes it (search/jobs/feeds/presence.ts). Every such
-- document stayed due forever, so each maintenance pass walked all of them to
-- find the few it could recrawl.
--
-- Measured in production (2026-10-17): 491,776 due job documents, all but 3 of
-- them feed-sourced, and 2 with a crawl origin; the sweep read ~132k blocks and
-- took ~54 s every 15 minutes to return 2 rows.
--
-- Ingest no longer schedules one (projection.ts). This clears the schedules it
-- left, exactly on the documents the sweep can never return — no crawl page
-- for their URL — so what gets recrawled does not change. A crawl of the same
-- URL later schedules it again (worker.ts).
--
-- `post`: the image still serving before the rollout keeps scheduling ingested
-- listings. The bulk (~490k rows) was cleared by hand in batches ahead of this
-- deploy; this pass is what the old image re-scheduled meanwhile, and the whole
-- set on a fresh install, where it is small.
SELECT set_config('clarity.recrawl_schedule_lock_timeout', current_setting('lock_timeout'), true),
       set_config('clarity.recrawl_schedule_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '300s';
--> statement-breakpoint
UPDATE "clarity_search_documents" AS d
SET "next_fetch_at" = NULL
WHERE d."document_type" = 'job'
  AND d."status" = 'indexed'
  AND d."next_fetch_at" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "clarity_crawl_pages" AS p WHERE p."url" = d."requested_url"
  );
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('clarity.recrawl_schedule_lock_timeout'), true),
       set_config('statement_timeout', current_setting('clarity.recrawl_schedule_statement_timeout'), true);
