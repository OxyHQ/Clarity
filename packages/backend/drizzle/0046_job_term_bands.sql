-- oxy:deploy-phase=pre
-- What a broad job query needs to be ranked in two phases, exactly
-- (search/jobs/lexical-ranking.ts). Measured in production (2026-10-21):
-- ranking "engineer" scored all 111k matches, reading every matching listing's
-- 4.3 KB vector, and took 30-65 s — past the search's 10 s statement timeout,
-- so every broad job query failed.
--
-- * `clarity_job_term_bands`: each listing's terms that occur at least 3, 6, 12
--   and 24 times in its `search_vector` (`clarity_job_term_band(v, b)`).
-- * `clarity_job_headlines`: its title and employer in short rows, for the
--   similarity candidates and their recheck.
--
-- Triggers keep both equal to the listing on every write;
-- `db/backfill-job-term-bands` fills the listings that predate them and
-- records itself in `clarity_job_term_bands_backfill`, which the two-phase
-- ranking requires. A database with no listings has nothing to fill: the
-- marker is written here.
CREATE TABLE "clarity_job_headlines" (
	"job_posting_id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"employer_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clarity_job_term_bands" (
	"job_posting_id" text PRIMARY KEY NOT NULL,
	"tf3" "tsvector" NOT NULL,
	"tf6" "tsvector" NOT NULL,
	"tf12" "tsvector" NOT NULL,
	"tf24" "tsvector" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clarity_job_term_bands_backfill" (
	"id" integer PRIMARY KEY NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_job_term_bands_backfill_single_row" CHECK ("clarity_job_term_bands_backfill"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "clarity_job_headlines" ADD CONSTRAINT "clarity_job_headlines_job_posting_id_clarity_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."clarity_job_postings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "clarity_job_term_bands" ADD CONSTRAINT "clarity_job_term_bands_job_posting_id_clarity_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."clarity_job_postings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "clarity_job_headlines_title_trgm_idx" ON "clarity_job_headlines" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "clarity_job_headlines_employer_trgm_idx" ON "clarity_job_headlines" USING gin ("employer_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "clarity_job_term_bands_tf3_idx" ON "clarity_job_term_bands" USING gin ("tf3");
--> statement-breakpoint
CREATE INDEX "clarity_job_term_bands_tf6_idx" ON "clarity_job_term_bands" USING gin ("tf6");
--> statement-breakpoint
CREATE INDEX "clarity_job_term_bands_tf12_idx" ON "clarity_job_term_bands" USING gin ("tf12");
--> statement-breakpoint
CREATE INDEX "clarity_job_term_bands_tf24_idx" ON "clarity_job_term_bands" USING gin ("tf24");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION clarity_job_term_band(v tsvector, minimum integer) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT array_to_tsvector(coalesce(array_agg(u.lexeme), '{}'::text[]))
  FROM unnest(v) AS u
  WHERE coalesce(array_length(u.positions, 1), 0) >= minimum
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION clarity_job_term_bands_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO clarity_job_term_bands (job_posting_id, tf3, tf6, tf12, tf24)
  VALUES (
    NEW.id,
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
CREATE OR REPLACE FUNCTION clarity_job_headlines_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO clarity_job_headlines (job_posting_id, title, employer_name)
  VALUES (NEW.id, coalesce(NEW.title, ''), coalesce(NEW.employer_name, ''))
  ON CONFLICT (job_posting_id) DO UPDATE SET
    title = EXCLUDED.title, employer_name = EXCLUDED.employer_name;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "clarity_job_term_bands_on_insert"
  AFTER INSERT ON "clarity_job_postings"
  FOR EACH ROW EXECUTE FUNCTION clarity_job_term_bands_sync();
--> statement-breakpoint
CREATE TRIGGER "clarity_job_term_bands_on_update"
  AFTER UPDATE OF "search_vector" ON "clarity_job_postings"
  FOR EACH ROW WHEN (OLD.search_vector IS DISTINCT FROM NEW.search_vector)
  EXECUTE FUNCTION clarity_job_term_bands_sync();
--> statement-breakpoint
CREATE TRIGGER "clarity_job_headlines_on_insert"
  AFTER INSERT ON "clarity_job_postings"
  FOR EACH ROW EXECUTE FUNCTION clarity_job_headlines_sync();
--> statement-breakpoint
CREATE TRIGGER "clarity_job_headlines_on_update"
  AFTER UPDATE OF "title", "employer_name" ON "clarity_job_postings"
  FOR EACH ROW WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.employer_name IS DISTINCT FROM NEW.employer_name)
  EXECUTE FUNCTION clarity_job_headlines_sync();
--> statement-breakpoint
INSERT INTO "clarity_job_term_bands_backfill" ("id")
  SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM "clarity_job_postings")
  ON CONFLICT ("id") DO NOTHING;
