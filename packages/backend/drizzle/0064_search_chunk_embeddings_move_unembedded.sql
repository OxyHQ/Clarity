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
-- The copy locks each chunk as 0063 does, for the same reason: a NULL-code row
-- whose chunk a re-chunk deleted meanwhile drops out instead of failing the
-- backlog's foreign key. The delete then removes only NULL-code rows whose
-- chunk the backlog holds, so none is lost unqueued.
--
-- The ~300k deleted rows are dead tuples, so one more autovacuum walks the
-- HNSW index after this deploy; it is the last one updates cause. No
-- ACCESS EXCLUSIVE lock: row locks only. A NULL-code row has no vector, so the
-- cascade to clarity_search_chunk_vectors deletes nothing.
INSERT INTO "clarity_search_chunk_backlog" ("chunk_id", "document_id")
SELECT "embedding"."chunk_id", "embedding"."document_id"
FROM "clarity_search_chunk_embeddings" AS "embedding"
INNER JOIN "clarity_search_chunks" AS "chunk" ON "chunk"."id" = "embedding"."chunk_id"
WHERE "embedding"."code" IS NULL
ORDER BY "chunk"."id"
FOR KEY SHARE OF "chunk"
ON CONFLICT ("chunk_id") DO NOTHING;
--> statement-breakpoint
DELETE FROM "clarity_search_chunk_embeddings" AS "embedding"
USING "clarity_search_chunk_backlog" AS "owed"
WHERE "embedding"."code" IS NULL AND "owed"."chunk_id" = "embedding"."chunk_id";
