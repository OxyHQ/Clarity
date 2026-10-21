# Search storage

What the search index keeps in Postgres, and why it is no bigger. The shared
instance (`oxy-postgres`) serves every Oxy product, so every byte Clarity stores
is a byte of cache another product loses.

## Measured (production, 2026-10-20)

Clarity's database was 64 GB, ~45% of the shared instance:

| Table | Size | What made it large |
|---|---|---|
| `clarity_search_chunks` | 32 GB | float32 `vector(1024)` embeddings (4.1 KB a chunk) and a stored full-text vector (2.2 KB) larger than the chunk's own text (1.2 KB), over 4.2M chunks |
| `clarity_search_documents` | 12 GB | page text and raw JSON-LD, 73% of documents being job listings |
| `clarity_job_postings` | 11 GB | the listing fields and their full-text vector |
| `clarity_image_cache` | 4.6 GB | the image bytes moved to Oxy Files (ADR 0043), never returned to the disk |

The image cache was rewritten (`VACUUM FULL`, 13 MB live) the same day:
4.6 GB → 22 MB.

## Chunks

A chunk stores its text, its embedding at **half precision** (`halfvec(1024)`)
and nothing derived from either.

- **Embeddings.** The semantic index and every query compare chunks at half
  precision (`searchChunkHalfvec`, migration 0034), so a float32 column kept
  twice the bytes for precision nothing read. Storing `halfvec` stores exactly
  the value `vector::halfvec(1024)` produced before: ranking is unchanged by
  construction.
- **Full-text vector.** The index is over the expression
  `to_tsvector('simple', text)` (`searchChunkTsvector`, migration 0040); a
  match uses the index and `ts_rank_cd` computes the vector for the matched
  chunks only — the same function on the same text, so lexical ranking is
  unchanged too.

### The compaction (one time)

Neither change can be made in place without a rewrite under an ACCESS
EXCLUSIVE lock, so the table is copied online into
`clarity_search_chunks_compact` and swapped:

1. **Deploy with migrations 0039–0042.** 0041 creates the copy and a trigger
   that mirrors every write on the live table into it.
2. **Run the one-shot** (an ECS task of the API image, like the other
   one-shots):

   ```bash
   bun packages/backend/dist/db/compact-search-chunks.js --target-database=clarity
   ```

   It copies the rows that predate the trigger (paced: it sleeps as long as it
   works), deletes copied rows the live table no longer has, compares both
   counts in one snapshot, builds the copy's GIN and HNSW indexes
   `CONCURRENTLY`, validates its foreign key and records the copy in
   `clarity_search_chunk_compaction`. It is idempotent: an interrupted run is
   run again.
3. **Deploy the swap** (0043–0045, `post`). It refuses unless the copy is
   recorded, its indexes valid and its foreign key validated; it then drops the
   live table and its trigger and gives the copy its name, constraints and
   index names. The one-shot and its table left the code with it; this section
   is the record of how the layout changed.

## Documents

A document stores what only it holds; what its chunks or its columns already
hold, it does not store again.

- **Page text.** Every indexed document is chunked from exactly the text it
  stores (`chunkText`: 2,000 characters every 1,600), so the text is its chunks
  laid end to end (`search/page-text.ts`). `main_content` keeps the text only
  when the chunks cannot give it back byte for byte: a document with no chunks
  (a `noindex` page), or a text `chunkText` cuts through a surrogate pair (the
  lone half is stored as U+FFFD). `getDocument`, `/v1/documents/:id` and
  `/v1/resolve` return the text from the chunks (`withPageText`); a result's
  snippet is cut from the first chunk, which holds the first 2,000 characters;
  a recrawl compares the new text with the chunks' (`documentChunkState`).
  Measured in production (2026-10-21): 2.8 KB a document over 1.3M documents.
- **JSON-LD.** Kept only for news, whose list falls back to it for a date or
  publisher its columns lack. Everything else a page states is a column,
  extracted when it is crawled. A job posting is projected once from its
  payload; a feed that lists it again without its page being read (still
  current, out of budget, or unreadable for now) records the sighting
  (`recordJobSighting`): exactly what re-ingesting the unchanged payload
  recorded — the document's observation, each listing's lifecycle status,
  reopening and `lastSeenAt`, the duplicate group's election — for every
  listing but those the last payload withdrew (`posting_absent`). It used to
  re-ingest a stored copy of the JSON-LD, 3.2 GB of it (2026-10-21).

`db/compact-document-text` (one-shot, idempotent, paced) cleared what rows
written before this stored twice, each row only if it still held what was read.

## Job postings

`clarity_job_postings.search_vector` (4.2 KB a listing) stays stored. Measured
alternatives, none of which keeps ranking and speed (2026-10-21):

- stripping positions (3.0 KB) breaks `ts_rank_cd`, which ranks by cover
  density and needs them;
- an expression index needs the exact text the vector is computed from, which
  `markdownToPlainText` builds in code; storing that text and computing the
  vector at query time made ranking a common query 40% slower (12.7 s → 17.6 s,
  every match is scored);
- `lz4` (already the default) does not compress a tsvector at all.
