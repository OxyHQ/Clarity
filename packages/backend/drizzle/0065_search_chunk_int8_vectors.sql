-- oxy:deploy-phase=pre
-- Each chunk's vector as 1,024 signed bytes, the store a search reorders its
-- candidates by under CLARITY_SEMANTIC_RERANK=int8
-- (docs/adr/0001-search-storage-diet.md, phase 2).
--
-- WHY. clarity_search_chunk_vectors holds each vector at half precision:
-- 2,056 bytes, three rows to a page, 41.0 GiB for 14.8M chunks (production,
-- 2026-11-28) — the largest table at Oxy. Measured on 100,732 production
-- vectors and the 57 query embeddings of the week's searches, an int8 vector
-- reorders the candidates to the same nearest documents (nDCG@10 0.998, chunk
-- recall@50 0.966 against 0.971) at seven rows a page: ~18 GiB for the same
-- chunks.
--
-- HELD. Deploy only once Clarity's PlanetScale cutover is done: no DDL runs
-- in production before. Additive: the image still serving neither reads nor
-- writes this table. Creating the foreign key takes SHARE ROW EXCLUSIVE on
-- clarity_search_chunk_embeddings for the moment it takes to check an empty
-- table.
CREATE TABLE "clarity_search_chunk_int8_vectors" (
	"chunk_id" text PRIMARY KEY NOT NULL,
	"vector" "bytea" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clarity_search_chunk_int8_vectors" ADD CONSTRAINT "clarity_search_chunk_int8_vectors_chunk_id_clarity_search_chunk_embeddings_chunk_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."clarity_search_chunk_embeddings"("chunk_id") ON DELETE cascade ON UPDATE no action;