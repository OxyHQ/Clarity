-- oxy:deploy-phase=post
-- Validates the compact copy's foreign key (added NOT VALID in 0043, or by the
-- one-shot). Already valid in production, where this returns at once.
ALTER TABLE "clarity_search_chunks_compact" VALIDATE CONSTRAINT "clarity_search_chunks_compact_document_fk";
