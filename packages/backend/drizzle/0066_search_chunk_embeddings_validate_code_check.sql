-- oxy:deploy-phase=post
-- oxy:statement-timeout=3600s
-- Validates 0065's check: one sequential read of the table's heap (4.0 GiB in
-- production, 2026-11-27) under SHARE UPDATE EXCLUSIVE, which blocks only
-- other DDL and vacuum — searches and writes go on. A running autovacuum of
-- the table is cancelled by the wait and runs again afterwards. Its own
-- migration: in 0065's transaction the scan would hold 0065's ACCESS EXCLUSIVE
-- lock.
ALTER TABLE "clarity_search_chunk_embeddings" VALIDATE CONSTRAINT "clarity_search_chunk_embeddings_code_not_null";
