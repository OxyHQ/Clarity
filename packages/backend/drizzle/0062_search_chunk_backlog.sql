-- oxy:deploy-phase=pre
-- The chunks still owed a current embedding get a table of their own, so that
-- `clarity_search_chunk_embeddings` (the table under the HNSW index over the
-- binary codes) is only ever inserted into (docs/search-storage.md,
-- "Insert-only codes").
--
-- WHY. Measured in production (2026-11-27): 15.1M embeddings rows, 14.56M
-- updates — every embedding turned a NULL code into a real one — and 1.42M
-- dead tuples. Each autovacuum that finds a dead tuple runs pgvector's bulk
-- delete over the 5.8 GiB HNSW index: three full passes plus the graph repair.
-- Those runs read ~5.2 TB in two weeks (1.0–1.7 TB each, 3–40 h), each lined up
-- with the shared instance's IO collapse. With no dead tuples PostgreSQL skips
-- index vacuuming, so an insert-only table stops them.
--
-- `pre`: additive. The image still serving keeps writing NULL-code rows into
-- the embeddings table and updating them; 0063 copies the ones that exist into
-- this table, and the `post` migration 0064 moves the rest.
--
-- Creating the foreign key takes SHARE ROW EXCLUSIVE on clarity_search_chunks
-- for the moment it takes to check an empty table.
CREATE TABLE "clarity_search_chunk_backlog" (
	"chunk_id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clarity_search_chunk_backlog" ADD CONSTRAINT "clarity_search_chunk_backlog_chunk_id_clarity_search_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."clarity_search_chunks"("id") ON DELETE cascade ON UPDATE no action;
