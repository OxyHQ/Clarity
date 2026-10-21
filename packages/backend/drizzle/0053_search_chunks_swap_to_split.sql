-- oxy:deploy-phase=post
-- The split copy replaces `clarity_search_chunks` (docs/search-storage.md,
-- "Vectors"): the chunk without its vector, the vector's binary code beside it
-- in `clarity_search_chunk_embeddings`, the vector in
-- `clarity_search_chunk_vectors`. The live table, its 4.3 GB HNSW index and its
-- mirror trigger go in the same transaction, so no write falls between them.
--
-- `post`: the image this deploy rolled out reads and writes vectors only in the
-- two vector tables, which 0050's trigger has kept complete, and reads chunks
-- only through the columns both chunk tables share.
--
-- Refuses unless the copy is complete: recorded by `db/split-search-chunks`
-- (or by 0050 on a database that had no chunks), every index valid and every
-- foreign key validated.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "clarity_search_chunk_split" WHERE "id" = 1) THEN
    RAISE EXCEPTION 'The split copy of clarity_search_chunks is not recorded: run db/split-search-chunks (docs/search-storage.md) first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid IN (
      'clarity_search_chunks_compact'::regclass,
      'clarity_search_chunk_embeddings'::regclass,
      'clarity_search_chunk_vectors'::regclass
    ) AND NOT i.indisvalid
  ) THEN
    RAISE EXCEPTION 'An index of the split copy is invalid: run db/split-search-chunks again';
  END IF;
  IF (
    SELECT count(*) FROM pg_constraint
    WHERE conname IN (
      'clarity_search_chunks_compact_document_fk',
      'clarity_search_chunk_embeddings_chunk_fk',
      'clarity_search_chunk_vectors_chunk_fk'
    ) AND convalidated
  ) <> 3 THEN
    RAISE EXCEPTION 'A foreign key of the split copy is not validated';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE "clarity_search_chunks";
--> statement-breakpoint
DROP FUNCTION IF EXISTS clarity_search_chunks_split_mirror();
--> statement-breakpoint
ALTER TABLE "clarity_search_chunks_compact" RENAME TO "clarity_search_chunks";
--> statement-breakpoint
ALTER TABLE "clarity_search_chunks" RENAME CONSTRAINT "clarity_search_chunks_compact_pkey" TO "clarity_search_chunks_pkey";
--> statement-breakpoint
ALTER TABLE "clarity_search_chunks" RENAME CONSTRAINT "clarity_search_chunks_compact_document_position_unique" TO "clarity_search_chunks_document_position_unique";
--> statement-breakpoint
ALTER TABLE "clarity_search_chunks" RENAME CONSTRAINT "clarity_search_chunks_compact_document_fk" TO "clarity_search_chunks_document_id_clarity_search_documents_id_fk";
--> statement-breakpoint
ALTER INDEX "clarity_search_chunks_compact_text_fts_idx" RENAME TO "clarity_search_chunks_text_fts_idx";
--> statement-breakpoint
ALTER TABLE "clarity_search_chunk_embeddings" RENAME CONSTRAINT "clarity_search_chunk_embeddings_chunk_fk" TO "clarity_search_chunk_embeddings_chunk_id_clarity_search_chunks_id_fk";
--> statement-breakpoint
ALTER TABLE "clarity_search_chunk_vectors" RENAME CONSTRAINT "clarity_search_chunk_vectors_chunk_fk" TO "clarity_search_chunk_vectors_chunk_id_clarity_search_chunk_embeddings_chunk_id_fk";
--> statement-breakpoint
DROP TABLE "clarity_search_chunk_split";
