-- oxy:deploy-phase=post
-- The split copy's indexes and foreign keys, before the swap (0053). In
-- production `db/split-search-chunks` built both indexes CONCURRENTLY and
-- added and validated the keys (docs/search-storage.md), so every statement
-- here passes over them; a fresh install, whose copy is empty, builds them
-- here.
CREATE INDEX IF NOT EXISTS "clarity_search_chunks_compact_text_fts_idx" ON "clarity_search_chunks_compact" USING gin (to_tsvector('simple'::regconfig, "text"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clarity_search_chunk_embeddings_code_hnsw_idx" ON "clarity_search_chunk_embeddings" USING hnsw ("code" bit_hamming_ops);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clarity_search_chunks_compact_document_fk') THEN
    ALTER TABLE "clarity_search_chunks_compact"
      ADD CONSTRAINT "clarity_search_chunks_compact_document_fk" FOREIGN KEY ("document_id")
      REFERENCES "clarity_search_documents"("id") ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clarity_search_chunk_embeddings_chunk_fk') THEN
    ALTER TABLE "clarity_search_chunk_embeddings"
      ADD CONSTRAINT "clarity_search_chunk_embeddings_chunk_fk" FOREIGN KEY ("chunk_id")
      REFERENCES "clarity_search_chunks_compact"("id") ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clarity_search_chunk_vectors_chunk_fk') THEN
    ALTER TABLE "clarity_search_chunk_vectors"
      ADD CONSTRAINT "clarity_search_chunk_vectors_chunk_fk" FOREIGN KEY ("chunk_id")
      REFERENCES "clarity_search_chunk_embeddings"("chunk_id") ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
