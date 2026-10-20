-- oxy:deploy-phase=post
-- The compact copy replaces `clarity_search_chunks` (docs/search-storage.md):
-- embeddings at half precision, no stored full-text vector. The live table and
-- its mirror trigger go in the same transaction, so no write falls between
-- them; the bytes they held (32 GB in production, 2026-10-20) return to the
-- disk when this commits.
--
-- `post`: the image this deploy rolled out writes `::halfvec(1024)`, which the
-- live float32 column accepted through pgvector's assignment cast during the
-- rollout, and reads only through the expressions both tables index
-- (`searchChunkHalfvec`, `searchChunkTsvector`).
--
-- Refuses unless the copy is complete: recorded by `db/compact-search-chunks`
-- (or by 0041 on a database that had no chunks), every index valid and the
-- foreign key validated.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "clarity_search_chunk_compaction" WHERE "id" = 1) THEN
    RAISE EXCEPTION 'The compact copy of clarity_search_chunks is not recorded: run db/compact-search-chunks (docs/search-storage.md) first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'clarity_search_chunks_compact'::regclass AND NOT i.indisvalid
  ) THEN
    RAISE EXCEPTION 'An index of clarity_search_chunks_compact is invalid: run db/compact-search-chunks again';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clarity_search_chunks_compact_document_fk' AND convalidated
  ) THEN
    RAISE EXCEPTION 'The foreign key of clarity_search_chunks_compact is not validated';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE "clarity_search_chunks";
--> statement-breakpoint
DROP FUNCTION IF EXISTS clarity_search_chunks_mirror();
--> statement-breakpoint
ALTER TABLE "clarity_search_chunks_compact" RENAME TO "clarity_search_chunks";
--> statement-breakpoint
ALTER TABLE "clarity_search_chunks" RENAME CONSTRAINT "clarity_search_chunks_compact_pkey" TO "clarity_search_chunks_pkey";
--> statement-breakpoint
ALTER TABLE "clarity_search_chunks" RENAME CONSTRAINT "clarity_search_chunks_compact_document_position_unique" TO "clarity_search_chunks_document_position_unique";
--> statement-breakpoint
ALTER TABLE "clarity_search_chunks" RENAME CONSTRAINT "clarity_search_chunks_compact_document_fk" TO "clarity_search_chunks_document_id_clarity_search_documents_id_f";
--> statement-breakpoint
ALTER INDEX "clarity_search_chunks_compact_text_fts_idx" RENAME TO "clarity_search_chunks_text_fts_idx";
--> statement-breakpoint
ALTER INDEX "clarity_search_chunks_compact_embedding_halfvec_hnsw_idx" RENAME TO "clarity_search_chunks_embedding_halfvec_hnsw_idx";
--> statement-breakpoint
DROP TABLE "clarity_search_chunk_compaction";
