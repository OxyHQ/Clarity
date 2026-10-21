-- oxy:deploy-phase=post
-- The employer trigram GIN served the similarity threshold the two-phase
-- ranking used before 0048; it now reads the nearest employers instead. `post`:
-- the image still serving during the rollout queries it.
DROP INDEX IF EXISTS "clarity_job_headlines_employer_trgm_idx";
