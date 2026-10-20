-- oxy:deploy-phase=pre
-- A chunk's full-text vector stops being stored (0042): the image this deploy
-- rolls out inserts chunks without one and matches on
-- `to_tsvector('simple', text)` through 0040's expression index. The image
-- still serving until the rollout ends keeps writing and reading the stored
-- column, so it stays, nullable, until 0042 drops it once no such image
-- remains.
--
-- DROP NOT NULL changes the catalogue only (no scan, no rewrite).
ALTER TABLE "clarity_search_chunks" ALTER COLUMN "search_vector" DROP NOT NULL;
