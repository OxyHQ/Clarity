-- oxy:deploy-phase=post
-- The listing's own full-text vector and its index go, once no serving image
-- reads them: the image this deploy rolled out reads and writes the vector in
-- `clarity_job_search_vectors` (0054, 0055). With them goes the trigger that
-- mirrored the column into it.
--
-- Refuses unless `db/copy-job-search-vectors` recorded the copy (or 0054 did,
-- on a database with no listings).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "clarity_job_search_vectors_copy" WHERE "id" = 1) THEN
    RAISE EXCEPTION 'The copy of the listings'' vectors is not recorded: run db/copy-job-search-vectors first';
  END IF;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "clarity_job_search_vectors_on_insert" ON "clarity_job_postings";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "clarity_job_search_vectors_on_update" ON "clarity_job_postings";
--> statement-breakpoint
DROP FUNCTION IF EXISTS clarity_job_search_vectors_mirror();
--> statement-breakpoint
DROP INDEX IF EXISTS "clarity_job_postings_search_idx";
--> statement-breakpoint
ALTER TABLE "clarity_job_postings" DROP COLUMN IF EXISTS "search_vector";
--> statement-breakpoint
DROP TABLE "clarity_job_search_vectors_copy";
