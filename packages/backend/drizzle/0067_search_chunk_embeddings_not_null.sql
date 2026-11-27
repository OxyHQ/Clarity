-- oxy:deploy-phase=post
-- `code` and `model` become NOT NULL. The valid check 0066 left
-- (`code IS NOT NULL AND model IS NOT NULL`) proves it, so `SET NOT NULL`
-- skips its scan; the check, the old `(code IS NULL) = (model IS NULL)` check
-- and the partial index over NULL codes (the backlog's primary key replaced it
-- for the sweep) then go. Catalogue changes only.
--
-- ACCESS EXCLUSIVE for that moment: refuse after 2s waiting for it (the
-- migrator retries with backoff). The index is dropped in this transaction,
-- not CONCURRENTLY: the migrator runs each migration in one, and the index
-- holds no rows once 0064 has run.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "clarity_search_chunk_embeddings" ALTER COLUMN "code" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "clarity_search_chunk_embeddings" ALTER COLUMN "model" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "clarity_search_chunk_embeddings" DROP CONSTRAINT "clarity_search_chunk_embeddings_code_not_null";
--> statement-breakpoint
ALTER TABLE "clarity_search_chunk_embeddings" DROP CONSTRAINT "clarity_search_chunk_embeddings_model_check";
--> statement-breakpoint
DROP INDEX "clarity_search_chunk_embeddings_unembedded_idx";
