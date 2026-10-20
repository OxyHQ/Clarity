-- oxy:deploy-phase=post
-- The compact copy's indexes and foreign key, before the swap (0045).
-- In production `db/compact-search-chunks` built both indexes CONCURRENTLY and
-- added and validated the key while the copy filled (docs/search-storage.md),
-- so every statement here passes over them; a fresh install, whose copy is
-- empty, builds them here.
CREATE INDEX IF NOT EXISTS "clarity_search_chunks_compact_text_fts_idx" ON "clarity_search_chunks_compact" USING gin (to_tsvector('simple'::regconfig, "text"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clarity_search_chunks_compact_embedding_halfvec_hnsw_idx" ON "clarity_search_chunks_compact" USING hnsw (("embedding"::halfvec(1024)) halfvec_cosine_ops);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clarity_search_chunks_compact_document_fk') THEN
    ALTER TABLE "clarity_search_chunks_compact"
      ADD CONSTRAINT "clarity_search_chunks_compact_document_fk" FOREIGN KEY ("document_id")
      REFERENCES "clarity_search_documents"("id") ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
