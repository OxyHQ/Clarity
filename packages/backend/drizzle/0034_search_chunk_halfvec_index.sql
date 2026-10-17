-- oxy:deploy-phase=pre
-- The semantic index at half precision (pgvector halfvec), beside the
-- full-precision one until no serving image orders by it (0035 drops it).
--
-- Measured in production (2026-10-17, pg_statio deltas over 4 min): the
-- full-precision HNSW index was the largest single reader on the shared,
-- I/O-bound instance — ~1,160 block reads a second for ~4.7 embedding writes a
-- second, each insert walking a 4.6 GB graph that does not fit in shared
-- buffers. A half-precision element is half the bytes, so the graph is about
-- half the pages: fewer pages per insert and per search, and far more of it
-- stays cached. The stored column stays `vector(1024)`; only the index (and the
-- query that must use it, `searchChunkHalfvec`) casts.
--
-- Built CONCURRENTLY by hand in production ahead of this deploy, so IF NOT
-- EXISTS passes over it; a fresh install builds it here, where the table is
-- small.
SELECT set_config('clarity.halfvec_index_lock_timeout', current_setting('lock_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clarity_search_chunks_embedding_halfvec_hnsw_idx" ON "clarity_search_chunks" USING hnsw (("embedding"::halfvec(1024)) halfvec_cosine_ops);
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('clarity.halfvec_index_lock_timeout'), true);
