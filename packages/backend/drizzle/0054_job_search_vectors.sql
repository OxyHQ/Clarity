-- oxy:deploy-phase=pre
-- Each listing's full-text vector in a table of its own, stored inline, which
-- replaces `clarity_job_postings.search_vector` once complete (docs/jobs.mdx,
-- "The lexical arm, in two phases").
--
-- WHY. Ranking reads the vectors of a query's candidates by key. In the
-- listing's TOAST, each vector is two or three random reads that Postgres
-- makes one at a time, whatever it is asked: scoring the 6.9k candidates of
-- "customer service" took 31 s cold (production, 2026-10-21). Stored inline
-- (`STORAGE MAIN`, ~3.7 KB, two to a page), a bitmap scan reads them ahead,
-- many pages at once (6,000 random rows: 0.1 s instead of 2.7 s).
--
-- HOW IT STAYS COMPLETE. As for the term bands (0046): this trigger writes the
-- vector of every listing inserted, or whose vector changes, from the moment
-- this migration commits; `db/copy-job-search-vectors` copies the listings
-- that predate it, `ON CONFLICT DO NOTHING` (a row the trigger wrote is
-- newer), checks the counts in one snapshot, builds the GIN index
-- CONCURRENTLY and records itself in `clarity_job_search_vectors_copy`, which
-- the switch requires. A listing's deletion cascades.
CREATE TABLE "clarity_job_search_vectors" (
	"job_posting_id" text PRIMARY KEY NOT NULL,
	"search_vector" "tsvector" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clarity_job_search_vectors" ALTER COLUMN "search_vector" SET STORAGE MAIN;
--> statement-breakpoint
ALTER TABLE "clarity_job_search_vectors" ADD CONSTRAINT "clarity_job_search_vectors_job_posting_id_clarity_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."clarity_job_postings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clarity_job_search_vectors_copy" (
	"id" integer PRIMARY KEY NOT NULL,
	"rows" bigint NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_job_search_vectors_copy_single_row" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION clarity_job_search_vectors_mirror() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO clarity_job_search_vectors (job_posting_id, search_vector)
  VALUES (NEW.id, NEW.search_vector)
  ON CONFLICT (job_posting_id) DO UPDATE SET search_vector = EXCLUDED.search_vector;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "clarity_job_search_vectors_on_insert"
  AFTER INSERT ON "clarity_job_postings"
  FOR EACH ROW EXECUTE FUNCTION clarity_job_search_vectors_mirror();
--> statement-breakpoint
CREATE TRIGGER "clarity_job_search_vectors_on_update"
  AFTER UPDATE OF "search_vector" ON "clarity_job_postings"
  FOR EACH ROW WHEN (OLD.search_vector IS DISTINCT FROM NEW.search_vector)
  EXECUTE FUNCTION clarity_job_search_vectors_mirror();
--> statement-breakpoint
INSERT INTO "clarity_job_search_vectors_copy" ("id", "rows")
  SELECT 1, 0 WHERE NOT EXISTS (SELECT 1 FROM "clarity_job_postings")
  ON CONFLICT ("id") DO NOTHING;
