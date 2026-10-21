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

## Vectors

A chunk's vector lives beside it, in two narrow tables, not in the chunk row:

| Table | Row | Read by |
|---|---|---|
| `clarity_search_chunk_embeddings` | the chunk's document, its vector's **binary code** (`binary_quantize`, one bit a dimension, 128 bytes) and model; NULL until embedded | the HNSW index over the codes, and the backlog sweep (partial index on `code is null`) |
| `clarity_search_chunk_vectors` | the half-precision vector, inline (`STORAGE PLAIN`) | the exact reordering of a search's candidates |

**Why.** Measured in production (2026-10-21), with the vector in the chunk row
and an HNSW index over the half-precision vectors (4.3 GB for 1.74M chunks):

- writing one vector read ~157 pages to place it in an index the cache could
  not hold, then rewrote the chunk row and every index on it. Those writes
  were the heaviest disk reader on the shared instance (Performance
  Insights, IO wait over 24 h: 0.45 of 2.39 average active sessions; over
  7 days 0.25 of 1.04);
- a search read the same index: 8,624 pages and 18.9 s for the jobs
  vertical's 1,000 nearest chunks, past the 10 s search timeout; 1,719 pages
  and 4.2 s for the web's 400;
- embedding the 2.6M chunks still owed a vector would have grown it to ~11 GB.

**How a search reads it.** The codes' HNSW index (~6× smaller than over the
halves) returns 8× the candidates the ranking needs, by Hamming distance; their
vectors are read with a bitmap scan, which the disk serves in parallel
(`effective_io_concurrency`: 6,000 random rows in 0.1 s instead of 2.7 s), and
ordered by their exact cosine distance.

**Ranking is not worse.** Measured on 346,800 production vectors (a 20% sample)
with 150 held-out short chunks as queries, against the exact nearest chunks:

| | chunk recall@400 | top-100 documents | chunk recall@1000 | top-200 documents |
|---|---|---|---|---|
| half-precision HNSW (before) | 0.962 | 0.988 | 0.970 | 0.994 |
| codes ×8, reordered exactly | 0.972 | 0.994 | 0.972 | — |
| codes ×6, reordered exactly | 0.959 | 0.993 | 0.961 | 0.994 |

### The split (one time)

The vector cannot leave the chunk row without a rewrite, so the table is copied
online, as for the compaction, into `clarity_search_chunks_compact` and the two
vector tables, and swapped:

1. **Deploy with migration 0050.** It creates the three tables and a trigger
   that mirrors every write on the live table into them.
2. **Run the one-shot** (an ECS task of the API image):

   ```bash
   bun packages/backend/dist/db/split-search-chunks.js --target-database=clarity
   ```

   It copies the rows that predate the trigger (paced), deletes copied rows
   whose chunk the live table no longer has, compares every count in one
   snapshot, builds the GIN and HNSW indexes `CONCURRENTLY`, adds and validates
   the three foreign keys (chunk → document, code → chunk, vector → code, each
   cascading) and records the copy in `clarity_search_chunk_split`. It is
   idempotent: an interrupted run is run again.
3. **Deploy the swap.** Its `post` migration refuses unless the copy is
   recorded, its indexes valid and its keys validated; it then drops the live
   table, its 4.3 GB index and its trigger, and gives the copy its name.

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
