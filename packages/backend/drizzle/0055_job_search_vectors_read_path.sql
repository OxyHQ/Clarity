-- oxy:deploy-phase=pre
-- The image this deploy rolls out writes and reads a listing's vector only in
-- `clarity_job_search_vectors` (0054), never in the listing's own column, which
-- 0056 drops once no image reads it.
--
-- * The column stops being required, so a listing the new image inserts
--   without it is accepted; the mirror trigger passes over a NULL vector, so
--   the old image's writes keep reaching the inline table and the new
--   image's never overwrite it.
-- * The term bands follow the inline table: its trigger keeps them from now
--   on, whichever image wrote the vector.
-- * The full-text index the one-shot built CONCURRENTLY in production; a
--   fresh install, whose table is empty, builds it here.
--
-- DROP NOT NULL changes the catalogue only.
ALTER TABLE "clarity_job_postings" ALTER COLUMN "search_vector" DROP NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION clarity_job_search_vectors_mirror() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.search_vector IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO clarity_job_search_vectors (job_posting_id, search_vector)
  VALUES (NEW.id, NEW.search_vector)
  ON CONFLICT (job_posting_id) DO UPDATE SET search_vector = EXCLUDED.search_vector;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION clarity_job_term_bands_from_vectors() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO clarity_job_term_bands (job_posting_id, tf3, tf6, tf12, tf24)
  VALUES (
    NEW.job_posting_id,
    clarity_job_term_band(NEW.search_vector, 3),
    clarity_job_term_band(NEW.search_vector, 6),
    clarity_job_term_band(NEW.search_vector, 12),
    clarity_job_term_band(NEW.search_vector, 24)
  )
  ON CONFLICT (job_posting_id) DO UPDATE SET
    tf3 = EXCLUDED.tf3, tf6 = EXCLUDED.tf6, tf12 = EXCLUDED.tf12, tf24 = EXCLUDED.tf24;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "clarity_job_term_bands_on_vector_insert"
  AFTER INSERT ON "clarity_job_search_vectors"
  FOR EACH ROW EXECUTE FUNCTION clarity_job_term_bands_from_vectors();
--> statement-breakpoint
CREATE TRIGGER "clarity_job_term_bands_on_vector_update"
  AFTER UPDATE OF "search_vector" ON "clarity_job_search_vectors"
  FOR EACH ROW WHEN (OLD.search_vector IS DISTINCT FROM NEW.search_vector)
  EXECUTE FUNCTION clarity_job_term_bands_from_vectors();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "clarity_job_term_bands_on_insert" ON "clarity_job_postings";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "clarity_job_term_bands_on_update" ON "clarity_job_postings";
--> statement-breakpoint
DROP FUNCTION IF EXISTS clarity_job_term_bands_sync();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clarity_job_search_vectors_search_idx" ON "clarity_job_search_vectors" USING gin ("search_vector");
