-- oxy:deploy-phase=pre
-- The chunks still owed a vector, in id order, so the worker's backlog sweep
-- (search/chunking.ts `queueEmbeddingBacklog`) finds them without scanning
-- 4.3M chunks. Partial: an embedded chunk leaves it, so it shrinks to nothing
-- as the backlog drains.
--
-- Built CONCURRENTLY by hand in production ahead of this deploy, so IF NOT
-- EXISTS passes over it; a fresh install builds it here.
CREATE INDEX IF NOT EXISTS "clarity_search_chunks_unembedded_idx" ON "clarity_search_chunks" USING btree ("id") WHERE "clarity_search_chunks"."embedding" is null;
