-- oxy:deploy-phase=pre
-- Authors become a document column (search/extractor.ts). The author tables and
-- clarity_search_document_aliases were never read and are empty in production
-- (2026-11-04); clarity_search_document_urls is the one URL-to-document record.
DROP TABLE "clarity_search_authors" CASCADE;--> statement-breakpoint
DROP TABLE "clarity_search_document_aliases" CASCADE;--> statement-breakpoint
DROP TABLE "clarity_search_document_authors" CASCADE;--> statement-breakpoint
ALTER TABLE "clarity_search_documents" ADD COLUMN "authors" jsonb DEFAULT '[]'::jsonb NOT NULL;