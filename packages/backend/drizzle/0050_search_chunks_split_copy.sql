-- oxy:deploy-phase=pre
-- The split copy of `clarity_search_chunks`, which replaces it in a later
-- `post` migration once it is complete (docs/search-storage.md, "The split").
--
-- WHY. Measured in production (2026-10-21), writing a chunk's vector was the
-- heaviest disk reader on the shared instance (Performance Insights, IO wait,
-- 24 h: 0.45 of 2.39 average active sessions): each one walked the HNSW index
-- over full half-precision vectors (4.3 GB for 1.74M chunks, uncached) and read
-- ~157 pages to place one vector, then rewrote the whole chunk row and every
-- index on it. A search walked the same index: 8,624 reads, 18.9 s, for the
-- jobs vertical's 1,000 nearest chunks. With the 2.6M chunks still owed a
-- vector embedded it would be ~11 GB.
--
-- THE LAYOUT IT ENDS WITH. Three tables, one row per chunk in the first two:
--
--   * `clarity_search_chunks_compact` — the chunk without its vector. Renamed
--     `clarity_search_chunks` by the swap.
--   * `clarity_search_chunk_embeddings` — the chunk's vector as its binary
--     code (`binary_quantize`, one bit a dimension: 128 bytes), its document
--     and the model that produced it; NULL until embedded. The HNSW index over
--     the codes is ~6× smaller than over the halves and stays in memory, and
--     the narrow rows it returns do too.
--   * `clarity_search_chunk_vectors` — the half-precision vector, stored
--     inline (STORAGE PLAIN: no TOAST lookup per row). A search reorders the
--     codes' nearest candidates by their exact distance, reading these rows
--     with a bitmap scan the disk serves in parallel.
--
-- Searching the codes for 8× the candidates and reordering them exactly finds
-- the true nearest chunks at least as often as the half-precision HNSW index
-- did (measured on 347k production vectors, docs/search-storage.md). A vector
-- is written to two narrow rows; the chunk row is no longer rewritten.
--
-- HOW IT STAYS COMPLETE. As for the compaction (0041):
--
--   1. This trigger mirrors every insert, update and delete on the live table
--      into the three copies from the moment this migration commits. An update
--      of only the vector touches the vector rows, not the chunk's copy.
--   2. `db/split-search-chunks` (one-shot) copies the rows that existed
--      before, in id order, `ON CONFLICT DO NOTHING` — a row the trigger
--      already wrote is newer and wins; deletes every copied row the live
--      table no longer has; compares the counts in one snapshot; builds the
--      indexes CONCURRENTLY; adds and validates the foreign keys; and only
--      then records itself in `clarity_search_chunk_split`.
--   3. The swap refuses unless that row exists.
--
-- No foreign keys while copying, for the reason 0041 gives: a batch checking
-- one would take key locks a concurrent document delete also needs.
--
-- A database with no chunks has nothing to copy: the marker is written here.
CREATE TABLE IF NOT EXISTS "clarity_search_chunks_compact" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"position" integer NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"text" text NOT NULL,
	"extractor_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_search_chunks_compact_document_position_unique" UNIQUE("document_id","position")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clarity_search_chunk_embeddings" (
	"chunk_id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"code" bit(1024),
	"model" text,
	CONSTRAINT "clarity_search_chunk_embeddings_model_check" CHECK (("code" IS NULL) = ("model" IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clarity_search_chunk_vectors" (
	"chunk_id" text PRIMARY KEY NOT NULL,
	"embedding" halfvec(1024) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clarity_search_chunk_vectors" ALTER COLUMN "embedding" SET STORAGE PLAIN;
--> statement-breakpoint
-- The chunks still owed a vector, for the backlog sweep; partial, so it
-- shrinks as they are embedded.
CREATE INDEX IF NOT EXISTS "clarity_search_chunk_embeddings_unembedded_idx" ON "clarity_search_chunk_embeddings" USING btree ("chunk_id") WHERE "code" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clarity_search_chunk_split" (
	"id" integer PRIMARY KEY NOT NULL,
	"rows" bigint NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_search_chunk_split_single_row" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION clarity_search_chunks_split_mirror() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id) THEN
    DELETE FROM clarity_search_chunk_vectors WHERE chunk_id = OLD.id;
    DELETE FROM clarity_search_chunk_embeddings WHERE chunk_id = OLD.id;
    DELETE FROM clarity_search_chunks_compact WHERE id = OLD.id;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.id IS DISTINCT FROM OLD.id
    OR (NEW.document_id, NEW.position, NEW.start_offset, NEW.end_offset, NEW.text, NEW.extractor_version, NEW.created_at)
      IS DISTINCT FROM (OLD.document_id, OLD.position, OLD.start_offset, OLD.end_offset, OLD.text, OLD.extractor_version, OLD.created_at)
  THEN
    INSERT INTO clarity_search_chunks_compact (
      id, document_id, position, start_offset, end_offset, text,
      extractor_version, created_at, updated_at
    ) VALUES (
      NEW.id, NEW.document_id, NEW.position, NEW.start_offset, NEW.end_offset, NEW.text,
      NEW.extractor_version, NEW.created_at, NEW.updated_at
    )
    ON CONFLICT (id) DO UPDATE SET
      document_id = EXCLUDED.document_id,
      position = EXCLUDED.position,
      start_offset = EXCLUDED.start_offset,
      end_offset = EXCLUDED.end_offset,
      text = EXCLUDED.text,
      extractor_version = EXCLUDED.extractor_version,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.id IS DISTINCT FROM OLD.id
    OR (NEW.document_id, NEW.embedding, NEW.embedding_model)
      IS DISTINCT FROM (OLD.document_id, OLD.embedding, OLD.embedding_model)
  THEN
    INSERT INTO clarity_search_chunk_embeddings (chunk_id, document_id, code, model)
    VALUES (
      NEW.id, NEW.document_id, binary_quantize(NEW.embedding)::bit(1024),
      CASE WHEN NEW.embedding IS NULL THEN NULL ELSE NEW.embedding_model END
    )
    ON CONFLICT (chunk_id) DO UPDATE SET
      document_id = EXCLUDED.document_id,
      code = EXCLUDED.code,
      model = EXCLUDED.model;
    IF NEW.embedding IS NULL THEN
      DELETE FROM clarity_search_chunk_vectors WHERE chunk_id = NEW.id;
    ELSE
      INSERT INTO clarity_search_chunk_vectors (chunk_id, embedding)
      VALUES (NEW.id, NEW.embedding)
      ON CONFLICT (chunk_id) DO UPDATE SET embedding = EXCLUDED.embedding;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "clarity_search_chunks_split_mirror"
  AFTER INSERT OR UPDATE OR DELETE ON "clarity_search_chunks"
  FOR EACH ROW EXECUTE FUNCTION clarity_search_chunks_split_mirror();
--> statement-breakpoint
INSERT INTO "clarity_search_chunk_split" ("id", "rows")
  SELECT 1, 0 WHERE NOT EXISTS (SELECT 1 FROM "clarity_search_chunks")
  ON CONFLICT ("id") DO NOTHING;
