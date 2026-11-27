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
-- Nothing is removed: the image still serving keeps reading and filling these
-- NULL-code rows. A row it fills meanwhile leaves a backlog row behind, which
-- the sweep drains by embedding the chunk once more without rewriting it
-- (`storeChunkEmbeddings`); a row it adds after this copy is moved by 0064.
INSERT INTO "clarity_search_chunk_backlog" ("chunk_id", "document_id")
SELECT "chunk_id", "document_id" FROM "clarity_search_chunk_embeddings"
WHERE "code" IS NULL
ON CONFLICT ("chunk_id") DO NOTHING;
