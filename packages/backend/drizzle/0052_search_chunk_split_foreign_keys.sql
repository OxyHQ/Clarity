-- oxy:deploy-phase=post
-- Validates the split copy's foreign keys (added NOT VALID in 0051, or by the
-- one-shot). Already valid in production, where each returns at once.
ALTER TABLE "clarity_search_chunks_compact" VALIDATE CONSTRAINT "clarity_search_chunks_compact_document_fk";
--> statement-breakpoint
ALTER TABLE "clarity_search_chunk_embeddings" VALIDATE CONSTRAINT "clarity_search_chunk_embeddings_chunk_fk";
--> statement-breakpoint
ALTER TABLE "clarity_search_chunk_vectors" VALIDATE CONSTRAINT "clarity_search_chunk_vectors_chunk_fk";
