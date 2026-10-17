-- oxy:deploy-phase=post
-- The full-precision semantic index, replaced by 0034's half-precision one.
-- `post`: the image still serving before the rollout orders by the
-- full-precision expression, so the index it reads goes only once no such image
-- remains. Every write to a chunk's embedding also stops paying for a second
-- HNSW insert from here on.
--
-- DROP INDEX takes ACCESS EXCLUSIVE on the chunks table for the moment it
-- runs; refuse after 5s waiting for it rather than queue every chunk read
-- behind it.
SELECT set_config('clarity.drop_vector_index_lock_timeout', current_setting('lock_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "clarity_search_chunks_embedding_hnsw_idx";
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('clarity.drop_vector_index_lock_timeout'), true);
