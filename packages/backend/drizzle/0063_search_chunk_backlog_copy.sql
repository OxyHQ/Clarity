-- oxy:deploy-phase=pre
-- oxy:statement-timeout=1800s
-- The chunks owed an embedding when this deploy starts: every NULL-code row of
-- `clarity_search_chunk_embeddings` (~300k in production, 2026-11-27), read
-- through `clarity_search_chunk_embeddings_unembedded_idx`, copied into the
-- backlog the image this deploy rolls out sweeps (search/chunking.ts
-- `queueEmbeddingBacklog`). Its own migration, apart from 0062, so the copy
-- runs without 0062's lock on clarity_search_chunks; each copied row only
-- key-share-locks its chunk for the foreign key.
--
-- Each chunk is locked (KEY SHARE, in id order) as it is read: the statement's
-- snapshot can still show a NULL-code row whose chunk a concurrent re-chunk has
-- just deleted, and copying it would fail the backlog's foreign key and abort
-- the deploy. Locked, a chunk deleted meanwhile drops out of the copy (its rows
-- went with it), and one that survives cannot be deleted until this commits. A
-- re-chunk the lock waits on longer than the runner's `lock_timeout`, or a
-- deadlock with one, rolls the copy back and the runner retries it.
--
-- Nothing is removed: the image still serving keeps reading and filling these
-- NULL-code rows. A row it fills meanwhile leaves a backlog row behind, which
-- the sweep drains by embedding the chunk once more without rewriting it
-- (`storeChunkEmbeddings`); a row it adds after this copy is moved by 0064.
INSERT INTO "clarity_search_chunk_backlog" ("chunk_id", "document_id")
SELECT "embedding"."chunk_id", "embedding"."document_id"
FROM "clarity_search_chunk_embeddings" AS "embedding"
INNER JOIN "clarity_search_chunks" AS "chunk" ON "chunk"."id" = "embedding"."chunk_id"
WHERE "embedding"."code" IS NULL
ORDER BY "chunk"."id"
FOR KEY SHARE OF "chunk"
ON CONFLICT ("chunk_id") DO NOTHING;
