-- oxy:deploy-phase=pre
-- The compact copy of `clarity_search_chunks`, which replaces it in a later
-- `post` migration once it is complete.
--
-- WHY A COPY. Measured in production (2026-10-20) the chunks table was 32 GB
-- of the shared instance: embeddings stored as float32 `vector(1024)` (4 KB a
-- chunk) though the semantic index, and every query, reads them at half
-- precision (`searchChunkHalfvec`, 0034); and a stored full-text vector larger
-- than its text (0040). Neither can be reclaimed in place: changing a column's
-- type rewrites the table under an ACCESS EXCLUSIVE lock for as long as the
-- rewrite takes, and a dropped column's bytes stay until a rewrite. So the
-- table is copied, online, into the layout it ends with:
--
--   * `embedding halfvec(1024)` — exactly the values the index and queries
--     already compare (`vector::halfvec` is the same cast either way), at half
--     the bytes;
--   * no `search_vector` — the full-text index is the expression of 0040.
--
-- HOW IT STAYS COMPLETE.
--
--   1. This trigger mirrors every insert, update and delete on the live table
--      into the copy from the moment this migration commits.
--   2. `db/compact-search-chunks` (one-shot, docs/search-storage.md) copies
--      the rows that existed before, in id order, `ON CONFLICT DO NOTHING` —
--      a row the trigger already wrote is newer and wins. A row deleted after
--      a batch read it but before it was inserted would come back, so the
--      one-shot then deletes every copied row the live table no longer has,
--      compares the two counts in one snapshot, builds the copy's indexes
--      CONCURRENTLY, validates its foreign key, and only then records itself
--      in `clarity_search_chunk_compaction`.
--   3. The swap refuses unless that row exists.
--
-- No foreign key while copying: a batch insert checking it would take a key
-- lock on the document that a concurrent document delete (cascading to the
-- live chunks, whose trigger deletes the copy) also needs. The one-shot adds
-- it NOT VALID and validates it once the copy is done; until then a deleted
-- document's chunks leave the copy through the trigger.
--
-- A database with no chunks has nothing to copy: the marker is written here,
-- so a fresh install swaps straight away.
CREATE TABLE IF NOT EXISTS "clarity_search_chunks_compact" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"position" integer NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" halfvec(1024),
	"embedding_model" text,
	"extractor_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_search_chunks_compact_document_position_unique" UNIQUE("document_id","position")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clarity_search_chunk_compaction" (
	"id" integer PRIMARY KEY NOT NULL,
	"rows" bigint NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_search_chunk_compaction_single_row" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION clarity_search_chunks_mirror() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM clarity_search_chunks_compact WHERE id = OLD.id;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
    DELETE FROM clarity_search_chunks_compact WHERE id = OLD.id;
  END IF;
  INSERT INTO clarity_search_chunks_compact (
    id, document_id, position, start_offset, end_offset, text,
    embedding, embedding_model, extractor_version, created_at, updated_at
  ) VALUES (
    NEW.id, NEW.document_id, NEW.position, NEW.start_offset, NEW.end_offset, NEW.text,
    NEW.embedding::halfvec(1024), NEW.embedding_model, NEW.extractor_version,
    NEW.created_at, NEW.updated_at
  )
  ON CONFLICT (id) DO UPDATE SET
    document_id = EXCLUDED.document_id,
    position = EXCLUDED.position,
    start_offset = EXCLUDED.start_offset,
    end_offset = EXCLUDED.end_offset,
    text = EXCLUDED.text,
    embedding = EXCLUDED.embedding,
    embedding_model = EXCLUDED.embedding_model,
    extractor_version = EXCLUDED.extractor_version,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "clarity_search_chunks_mirror"
  AFTER INSERT OR UPDATE OR DELETE ON "clarity_search_chunks"
  FOR EACH ROW EXECUTE FUNCTION clarity_search_chunks_mirror();
--> statement-breakpoint
INSERT INTO "clarity_search_chunk_compaction" ("id", "rows")
  SELECT 1, 0 WHERE NOT EXISTS (SELECT 1 FROM "clarity_search_chunks")
  ON CONFLICT ("id") DO NOTHING;
