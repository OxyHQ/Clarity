-- oxy:deploy-phase=post
-- The listings' title trigram index (188 MB) goes: nothing reads it. The
-- lexical match's title arm reads `clarity_job_headlines` (0046), whose rows are
-- short; the only statement that still used this one was a scoring query that
-- the planner turned into a scan of it (fixed in #169). Every listing update
-- that is not HOT — a daily sighting moves the indexed `last_seen_at` —
-- re-inserted the title's trigrams into it.
DROP INDEX IF EXISTS "clarity_job_postings_title_trgm_idx";
