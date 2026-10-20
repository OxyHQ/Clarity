-- oxy:deploy-phase=post
-- The stored chunk full-text vector and its index go, once no serving image
-- reads them: the image this deploy rolled out matches and ranks on
-- `to_tsvector('simple', text)` through 0040's expression index. Dropping the
-- index returns its pages at once; the column's bytes stay in the table until
-- it is rewritten, which the compact copy (0041) does.
--
-- Both statements change the catalogue only.
DROP INDEX IF EXISTS "clarity_search_chunks_fts_idx";
--> statement-breakpoint
ALTER TABLE "clarity_search_chunks" DROP COLUMN IF EXISTS "search_vector";
