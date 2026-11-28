# ADR 0001: the search storage diet

- **Status:** proposed, 2026-11-28. Nothing here has run in production. Every
  deletion is the owner's decision; every DDL waits for Clarity's PlanetScale
  cutover.
- **Evidence:** `docs/audits/2026-11-28-search-storage-diet/` (the two
  read-only probes and their output).
- **Related:** #261 (insert-only codes, merged), #263 (codes NOT NULL, held),
  #262 (retention one-shot, draft), `docs/search-storage.md`.

## Resumen (para el owner)

La base `clarity` ocupa **155 GiB**. Se puede bajar a **~100 GiB sin perder
calidad** y a **~70 GiB** si aceptas borrar todos los empleos muertos y una
búsqueda semántica algo menos fiel.

- **Lo más grande es duplicado.** Cada trozo de texto guarda su vector dos
  veces: el vector en media precisión (41 GiB) y su código binario (11 GiB con
  el índice). Un vector **int8** (1 KiB en vez de 2 KiB) da los mismos
  resultados: nDCG@10 0.998 frente al actual, medido con las búsquedas reales
  de la semana. Ahorro: **~23 GiB**.
- **La mitad de los empleos están muertos.** El 52 % de las ofertas no están
  activas (stale, closed, expired). Ninguna búsqueda normal las devuelve, pero
  ocupan unos 42 GiB entre texto, vectores e índices. Borrar las que llevan
  más de 30 días sin verse libera **~23 GiB**. Borrarlas todas libera ~42 GiB.
  Vuelven solas si la fuente las publica otra vez.
- **Lo que no sirve:**
  - **Truncar dimensiones** (Matryoshka 1024 → 512) cambia el 18 % del top-10.
  - **Pasar los vectores a Cloudflare Vectorize.** Devuelve como mucho 100
    resultados por consulta y Clarity necesita entre 3.200 y 8.000. Además
    sería un segundo almacén, que las reglas de Clarity prohíben.
- **Pasos.** Todo espera al corte a PlanetScale. Cada paso se puede deshacer:
  1. Retención: auditoría de crawl a 14 días, empleos muertos a 30 días y
     eventos de uso a 35 días.
  2. Vectores int8 detrás de un flag, con backfill. Después se dejan de
     escribir los de media precisión y, si das el visto bueno, se borra esa
     tabla.
  3. Ajustes de Postgres: índices sin uso, compresión del texto y la
     descripción duplicada de los empleos.

## Context

Measured on production, read-only, on 2026-11-28 (`oxy_migrator` in a
read-only session, one-shot ECS task; nothing written). `pg_database_size`:
**155.4 GiB**.

| Area | GiB | What |
|---|---|---|
| Chunk vectors (`clarity_search_chunk_vectors`) | 41.0 | halfvec(1024) inline: 2,056 B a vector, **3 rows a page** → 2.9 KiB a chunk on disk |
| Chunks (`clarity_search_chunks`) | 32.9 | heap 21.3, full-text GIN 9.1, keys 2.3 |
| Codes (`clarity_search_chunk_embeddings`) | 11.1 | heap 4.0, HNSW over the codes 5.8, key 1.1 |
| Documents (+ URLs) | 19.3 | heap 5.8, TOAST 9.3, indexes 3.1 |
| Job listings and their search tables | 36.8 | postings 13.3, `job_search_vectors` 15.2, signatures 4.0, term bands 2.1, headlines 1.4, feed links 0.8 |
| Crawl pages, operations, fetch attempts | 8.3 | |
| Usage events | 4.7 | 8.7M rows |
| Everything else | ~1.3 | images, hosts, rollups, … |

One embedded chunk costs **5.9 KiB** across its three tables. 15.3M chunks
exist; 647k are still owed an embedding.

**Who owns the chunks.** Measured on a 0.1 % block sample of 15,426 chunks:

| Kind of chunk | Share of all chunks |
|---|---|
| Job documents | 45.3 % |
| Pages | 41.0 % |
| News | 8.4 % |
| Articles | 4.0 % |

The job chunks split by their document's listings:

| Listings of the document | Share of job chunks |
|---|---|
| Active | 48.3 % |
| Only stale | 39.8 % |
| Only closed | 9.2 % |
| Only expired | 2.7 % |

So **23.4 % of all chunks** belong to listings that no default search returns.

**Search traffic is tiny.** The Redis query-embedding cache (7-day TTL) held
**57 distinct queries**. Usage events are 66 % `fetch_started`, 34 %
`page_indexed` and ~0.02 % `search`. The database costs Clarity far more than
its queries do.

## The questions, answered

### 1. Duplication

- **Page text in documents and chunks: no.** `main_content` is kept only when
  the chunks cannot give the text back. In the sample that was 5 of 5,343
  indexed pages, plus `noindex` pages, which have no chunks. The chunks
  overlap, though: 2,000 characters every 1,600, so they hold ~1.25× the page
  text, with 2.8 chunks per job document and 3.4 per page.
- **Vectors twice: yes.** Each chunk has:
  - its half-precision vector, 2.8 KiB on disk;
  - its binary code (`binary_quantize`, the signs of the same vector, 128 B),
    under the HNSW index.

  The code is derived from the vector. The vector is read only to reorder
  8× the needed candidates (3,200 for a web search, 8,000 for jobs). Holding
  that reorder at half precision costs 41 GiB.
- **A job listing's text exists five times:**
  - `clarity_job_postings.description` (markdown, 2.8 KB stored) and the
    other sections;
  - `clarity_search_documents.description`: the first 2,000 plain characters
    again, 1.3 KB stored, ~3 GiB over 2.4M job documents;
  - the chunks: title, employer and up to 8,000 characters of the
    description, ~3.6 KB stored, plus the chunk GIN and the vectors;
  - `clarity_job_search_vectors`: a positional tsvector, 4.3 KB inline, which
    lz4 does not compress;
  - `clarity_job_term_bands`: four stripped tsvectors with four GINs.

  `clarity_job_headlines` copies the title and employer as well. Altogether a
  listing costs ~35 KiB: ~16 chunk side, 3.6 document, 15.2 listing side.
  Duplicate listings add more: 240k clusters hold ~2.5 members each, so ~360k
  listings (14 %) are non-canonical copies with their own document, chunks and
  vectors.

### 2. Vector size

The eval: the 57 real query embeddings, plus 300 held-out chunks as queries,
against a 100,732-vector sample of production. The sample is 200 evenly spread
block ranges of `clarity_search_chunk_vectors`, 52,449 documents.

The gold standard is the exact cosine at 1024 dimensions. Every variant takes
the codes' 8× Hamming candidates (except the scans), as production does, and
reorders them by the store named. "nDCG@10" is the top 10 documents built from
the top 400 chunks, which is the semantic arm's real shape, graded against the
gold.

| Reorder by | Bytes/chunk | Real queries: chunk R@10 | chunk R@50 | doc nDCG@10 | Chunk queries: doc nDCG@10 | known-item MRR@10 |
|---|---|---|---|---|---|---|
| **halfvec 1024 (today)** | 2,048 | 0.921 | 0.971 | 1.000 | 1.000 | 0.690 |
| **int8 1024** | 1,024 | 0.912 | 0.966 | **0.998** | 0.996 | 0.688 |
| int4 1024 | 512 | 0.840 | 0.865 | 0.923 | 0.936 | 0.685 |
| halfvec 512 (Matryoshka prefix) | 1,024 | 0.691 | 0.679 | 0.821 | 0.844 | 0.682 |
| int8 512 | 512 | 0.690 | 0.680 | 0.819 | 0.845 | 0.682 |
| halfvec 256 | 512 | 0.577 | 0.593 | 0.708 | 0.754 | 0.678 |
| exact 512, full scan (an HNSW at 512) | 1,024 | 0.698 | 0.679 | 0.821 | 0.844 | 0.682 |
| no vectors: query × code signs | 0 | 0.649 | 0.667 | 0.775 | 0.824 | 0.687 |
| no vectors: Hamming only | 0 | 0.519 | 0.553 | 0.653 | 0.747 | 0.688 |
| halfvec 1024, 4× candidates | 2,048 | 0.832 | 0.890 | 1.000 | 1.000 | 0.690 |

- **Matryoshka: no.** Qwen3-Embedding-8B is MRL-trained, and Kaana takes
  `dimensions`. But the 512-dimension prefix changes ~18 % of the top-10
  documents and a third of the top-50 chunks. That holds for the prefix and
  for a scan at 512 alike.
- **int8: yes.** It is the same ranking at half the bytes. Each vector is
  scaled by 127/max|x|; the scale is not stored, because a cosine does not
  depend on it.
- **int4 and binary-only:**
  - int4 loses 8 % of the top 10.
  - Ordering by the codes alone, with the query's floats against the code's
    signs, loses 22 %.
  - The known-item proxy barely moves (0.687 against 0.690). This is the one
    relevance signal available: the query chunk's own document, found through
    its other chunks. Most of what moves are near-ties.

  Without relevance labels, which a 57-query week cannot give, these stay a
  later, owner-approved step (phase 4). They are not the default.
- **Full precision: not kept.** It is already gone (float32 was dropped for
  halfvec on 2026-10-20). int8 replaces halfvec.

**Caveats.**

- The sample is 0.68 % of the corpus. Its k=10 is about as deep as k=1,400 over
  15M chunks.
- The HNSW's own approximation is not modelled. It is the same for every
  variant, which reorders the same candidates.
- Fidelity to exact search is not relevance.

### 3. What deserves storage

#### Dead jobs

- A dead job document weighs ~36.5 KiB with its vectors (#262 has the
  derivation).
- 52 % of listings are not active, ~1.27M documents.
- The 90-day worker pass (`JOB_RETENTION_DAYS`) first finds work around
  2026-12-15, because the corpus starts 2026-09-16.

| Window | Frees |
|---|---|
| Closed or expired, 30 days | ≤11 GiB |
| Plus stale unseen for 30 days | ≤23.5 GiB |
| Every non-active listing | ≤42 GiB |

Keeping metadata only (the listing row without chunks, vectors or search
tables) would keep ~6 KiB of the 36.5 KiB. A deleted document comes back on its
next sighting anyway, so a full delete is simpler and loses nothing a source
still lists. The one product effect: an explicit `statuses=closed` filter finds
fewer old listings.

#### Pages

- 10 % of indexed pages have no chunks.
- `noindex` pages keep their text, which comes to ~0.3 GiB.
- There are no click logs, so "low value" cannot be measured yet.
- Page chunks are 41 % of chunks, ~35 GiB, and most of the non-job growth.

Two candidates need their own eval: embedding only the first chunks of long
documents, and no overlap for new chunking.

#### Crawl audit (#262)

| Window | Frees now | Plateau |
|---|---|---|
| 30 days | ≈1.7 GiB | ~3.4 GiB |
| 14 days | ≈4.1 GiB | ~1.5 GiB |

Nothing reads finished fetch attempts. The recrawl-origin page of each job
document must stay.

#### Usage events

- 20 % are older than 30 days, 51 % older than 14 days.
- Quotas read the monthly rollups.
- The events are only the idempotency guard and per-call evidence.

Keeping 35 days, the month in progress and the one before, frees ~1 GiB and
caps the table near 3.7 GiB. A retry of an idempotency key older than 35 days
would count again, which is acceptable.

### 4. Postgres-level

- **TOAST lz4:** it is already the default (`default_toast_compression = lz4`).
- **Chunk text** is stored at 1,263 B for 1,558 B of text. Rows just under the
  ~2 KB TOAST threshold are not compressed at all. A lower `toast_tuple_target`
  on `clarity_search_chunks` (DDL; it applies to new rows, and 34 % of chunks
  rotate every 30 days) would compress them inline. Estimate: up to ~5 GiB.
  Measure it on a copy first.
- **Unused indexes:** the statistics restarted a few hours before the probe
  (every counter is young), so `idx_scan = 0` proves nothing yet. The code has
  no reader for:
  - `clarity_search_usage_account_time_idx` (0.50 GiB);
  - `clarity_job_postings_employer_idx` (0.05 GiB);
  - #263's `clarity_search_chunk_embeddings_unembedded_idx` (0.13 GiB).

  Confirm with 14 days of statistics on PlanetScale before dropping anything.
- **Bloat:**
  - Documents use 15.1 GiB of heap and TOAST for an estimated ~12 GiB of live
    rows. The difference is space the text compaction freed for reuse.
  - The vectors table carries 1.4 GiB of TOAST from before `STORAGE PLAIN`.

  A logical copy to PlanetScale leaves both behind, so measure there before
  repacking anything.
- **Row layouts:**
  - Chunk keys are UUIDs stored as text (37 B, repeated in three tables and
    their keys).
  - Every code row stores the model name (24 B).

  A `uuid` key and a model id would save ~1.5 GiB, but the rewrites are not
  worth it alone. Fold them into a rewrite that happens anyway.

### 5. Architecture: keep the vectors in Postgres

| | pgvector (codes + int8) | Cloudflare Vectorize | Files on R2 |
|---|---|---|---|
| Fit | One statement with the document filters, in the same transaction as chunk writes and deletes | topK ≤ 100 (≤ 50 with metadata); Clarity reads 3,200–8,000 candidates a search. 1536 dims max (fine) | No random-access ANN: a custom service would hold the index in memory |
| Consistency | Cascades with the chunks | A second store mirrored on every re-chunk and delete: the dual write `AGENTS.md` forbids | Same as Vectorize |
| Latency | In the database, ~ms; int8 adds ~1 KiB a candidate to transfer and score in the API (≈3 MB web, ≈8 MB jobs; tens of ms) | A cross-cloud call from us-west-2 ECS (~50–150 ms) plus a Postgres join | Depends on the service |
| Cost | Storage in the PlanetScale cluster SKU: 18 GiB int8 + 11 GiB codes | Cheap: 15.4B stored dims ≈ $8/month, queries ≈ free, on the credits | R2 storage ≈ free; compute is the cost |
| Effort | This PR | High: a new boundary, a sync, a Worker or REST client, backfill | Highest |

PlanetScale for Postgres supports pgvector (HNSW, halfvec). The credits argue
for Cloudflare, but Vectorize cannot return the candidate pool the ranking
needs, and a mirrored store would break the Postgres-only rule. Shrinking the
vectors in place gets most of the bytes back for a fraction of the work.

## Decision

Diet in four phases, each reversible. All of them run after the PlanetScale
cutover: phases 1 and 3 delete or change the schema, and phase 2's PR carries
its migration (DDL), so it is held too.

| Phase | What | Saves | Quality | Reversible by | Needs |
|---|---|---|---|---|---|
| 1. Retention (#262) | Crawl audit 14 d; dead job documents, unseen 30 d, stale included; usage events 35 d | ~28.6 GiB (4.1 + 23.5 + 1.0) | None by default: dead listings leave every default search; they also stop taking semantic candidate slots | RDS/PlanetScale snapshot and PITR; listings re-ingest on their next sighting | **Owner: approve each deletion** |
| 2. int8 reorder (this PR) | `clarity_search_chunk_int8_vectors` (0065), written for every new embedding; `db/backfill-chunk-int8` (inserts only, sequential, paced); then `CLARITY_SEMANTIC_RERANK=int8`; then `CLARITY_STORE_CHUNK_VECTORS=false`; then drop `clarity_search_chunk_vectors` | ~21 GiB after phase 1 (~23 before): 41 → ~18 GiB | nDCG@10 0.998 | Flip the flag back while the halves exist; after the drop, re-embed (Kaana) or rebuild halves from int8 | Cutover for 0065; **owner: the drop** |
| 3. Postgres-level | Indexes unused for 14 days on PlanetScale; chunk `toast_tuple_target`; job documents read their description from the listing instead of storing it; repack only if the copy kept bloat | ~5–10 GiB | None | Re-create the index; reset the parameter | Cutover; measurements on PlanetScale |
| 4. Deeper (later) | Code-only reorder (drop int8 too); first-K-chunk embedding; no embeddings for non-canonical duplicates; all non-active jobs | up to ~30 GiB more | −22 % top-10 fidelity for code-only; the rest unmeasured | Flags; re-embedding | A labeled eval, and the owner |

**Target:**

| Plan | Size | Change |
|---|---|---|
| Phases 1–3 | **≈ 100 GiB** (96–101) | −35 %, with no measured quality loss |
| With phase 4 | ≈ 70 GiB | −55 % |

A new chunk then costs ~4.2 KiB instead of 5.9 KiB (~3.0 KiB with code-only),
and the job churn stops growing past its window.

**Speed:**

- int8 reads the same number of rows from a table 2.3× smaller, so more of it
  stays in cache. It moves the scoring of 3,200–8,000 candidates into the API.
- Phase 1 takes the dead listings' candidates out of every semantic pool.
- `CLARITY_SEMANTIC_RERANK=codes` reads no vector at all, which makes it the
  lever for an instance short of IOPS.

## Consequences

- Until phase 2's drop, the database briefly holds both stores (+18 GiB).
  Run phase 1 first so that the backfill copies less.
- Deleting rows frees space for reuse, not disk. On RDS the volume never
  shrinks; on PlanetScale, check how storage is billed before counting the
  saving as money.
- The probes are re-runnable: `docs/audits/2026-11-28-search-storage-diet/`.
  Re-run the vector eval when the embedding model changes.
