-- oxy:deploy-phase=post
-- oxy:statement-timeout=1800s
-- The last NULL-code rows of `clarity_search_chunk_embeddings` move to the
-- backlog (docs/search-storage.md, "Insert-only codes"): those the previous
-- image wrote after 0063 copied the rest, and any it left unembedded. Then
-- they are deleted, through the partial index `code IS NULL`.
--
-- `post`: the previous image wrote these rows; the image now serving writes a
-- chunk's embeddings row only once its code exists, and fills a leftover
-- NULL-code row it embeds meanwhile (a row it fills is no longer matched
-- here).
--
-- The ~300k deleted rows are dead tuples, so one more autovacuum walks the
-- HNSW index after this deploy; it is the last one updates cause. No
-- ACCESS EXCLUSIVE lock: row locks only. A NULL-code row has no vector, so the
-- cascade to clarity_search_chunk_vectors deletes nothing.
INSERT INTO "clarity_search_chunk_backlog" ("chunk_id", "document_id")
SELECT "chunk_id", "document_id" FROM "clarity_search_chunk_embeddings"
WHERE "code" IS NULL
ON CONFLICT ("chunk_id") DO NOTHING;
--> statement-breakpoint
DELETE FROM "clarity_search_chunk_embeddings" WHERE "code" IS NULL;
