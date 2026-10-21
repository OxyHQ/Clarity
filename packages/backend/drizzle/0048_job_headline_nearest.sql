-- oxy:deploy-phase=pre
-- The titles and employers nearest a query, in order (`<->`, 1 - similarity),
-- for the two-phase lexical ranking (search/jobs/lexical-ranking.ts): its
-- similarity candidates are the M nearest headlines, and the M-th's similarity
-- bounds every listing left out. A fixed threshold either missed the bound or,
-- for a query of common words, brought more than 20k candidates, and the
-- search fell back to scoring every match and timed out (production,
-- 2026-10-21: "software engineer", "data analyst", "react developer").
--
-- Built CONCURRENTLY by hand in production ahead of this deploy, so IF NOT
-- EXISTS passes over them; a fresh install builds them here.
CREATE INDEX IF NOT EXISTS "clarity_job_headlines_title_knn_idx" ON "clarity_job_headlines" USING gist ("title" gist_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clarity_job_headlines_employer_knn_idx" ON "clarity_job_headlines" USING gist ("employer_name" gist_trgm_ops);
