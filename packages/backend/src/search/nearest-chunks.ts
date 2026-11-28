/**
 * The semantic arm's nearest chunks (docs/search-storage.md, "Vectors").
 *
 * Two reads, both in the caller's transaction:
 *
 *   1. The HNSW index over the chunks' binary codes returns
 *      {@link CANDIDATE_OVERSAMPLING} × `count` candidates by Hamming distance.
 *      The index and the narrow rows it returns stay in memory.
 *   2. Their half-precision vectors are read with a bitmap scan — the disk
 *      serves its pages in parallel, up to {@link VECTOR_READ_CONCURRENCY} at
 *      a time — and the `count` nearest by exact cosine distance are kept.
 *
 * Measured on 346,800 production vectors, this finds the true nearest chunks
 * at least as often as the HNSW index over the half-precision vectors did
 * (recall@400 0.972 against 0.962), which read up to 8,624 pages a search
 * from an index the cache could not hold.
 *
 * `CLARITY_SEMANTIC_RERANK` (semantic-rerank.ts) picks what step 2 reads:
 * the half-precision vectors (`vectors`, the default), the int8 vectors
 * (`int8`: half the bytes, the same nearest documents), or nothing (`codes`:
 * the candidates are ordered by the query against their codes' signs)
 * (docs/adr/0001-search-storage-diet.md).
 */
import { sql } from 'drizzle-orm';

import type { ClarityExecutor } from '../db/index.js';
import { isStatementTimeout, SEARCH_STATEMENT_TIMEOUT_MS } from './search-timeout.js';
import {
  codeDistance,
  int8Distance,
  type SemanticRerank,
  semanticRerank,
  vectorNorm,
} from './semantic-rerank.js';

/** Candidates read from the codes' index for each chunk kept. */
export const CANDIDATE_OVERSAMPLING = 8;
/**
 * Pages a bitmap scan asks the disk for ahead of reading them. The shared
 * instance's default (1) reads one at a time: 6,000 random vectors took 2.7 s
 * cold; at 128 they took 0.1 s (production, 2026-10-21).
 */
const VECTOR_READ_CONCURRENCY = 128;
/** pgvector's ceiling for `hnsw.ef_search`; a larger pool is read iteratively. */
const EF_SEARCH_CEILING = 1_000;

export interface NearestChunks {
  /** The document of each chunk, nearest first; a document repeats once per chunk. */
  documentIds: string[];
  distances: number[];
}

/** The `count` chunks nearest `embedding`, nearest first. */
export async function nearestChunks(
  tx: ClarityExecutor,
  embedding: readonly number[],
  count: number,
  /** A test seam; the deployment's `CLARITY_SEMANTIC_RERANK` otherwise. */
  rerank: SemanticRerank = semanticRerank(),
): Promise<NearestChunks> {
  const query = JSON.stringify(embedding);
  const pool = count * CANDIDATE_OVERSAMPLING;
  // `set local` takes no bind parameter; every value is a module constant or
  // derived from one.
  await tx.execute(sql.raw(`set local hnsw.ef_search = ${Math.min(pool, EF_SEARCH_CEILING)}`));
  // A pool past `ef_search` is read by resuming the scan, in approximately
  // ascending order; the rerank below reorders it anyway.
  await tx.execute(sql.raw(`set local hnsw.iterative_scan = relaxed_order`));
  // The `codes` rerank reads each candidate's code with it (`varbit_send`,
  // 132 bytes, from the row the index scan fetches anyway) and nothing else.
  const candidates = await tx.execute<{
    chunkId: string;
    documentId: string;
    code?: Uint8Array;
  }>(sql`
    select chunk_id as "chunkId", document_id as "documentId"
      ${rerank === 'codes' ? sql`, varbit_send(code) as code` : sql``}
    from clarity_search_chunk_embeddings
    order by code <~> binary_quantize(${query}::halfvec(1024))::bit(1024)
    limit ${pool}`);
  if (candidates.length === 0) return { documentIds: [], distances: [] };

  const documentOf = new Map(candidates.map((row) => [row.chunkId, row.documentId]));
  const norm = vectorNorm(embedding);
  let scored: { chunkId: string; distance: number }[];
  if (rerank === 'codes') {
    scored = candidates.map((row) => ({
      chunkId: row.chunkId,
      distance: codeDistance(embedding, norm, row.code as Uint8Array),
    }));
  } else {
    // An index scan would read the vectors one page at a time, in candidate
    // order; the bitmap scan reads them in physical order and ahead.
    await tx.execute(sql.raw(`set local enable_indexscan = off`));
    await tx.execute(sql.raw(`set local effective_io_concurrency = ${VECTOR_READ_CONCURRENCY}`));
    let owed = candidates.map((row) => row.chunkId);
    scored = [];
    if (rerank === 'int8') {
      const quantized = await tx.execute<{ chunkId: string; vector: Uint8Array }>(sql`
        select chunk_id as "chunkId", vector
        from clarity_search_chunk_int8_vectors
        where chunk_id = any(${sql.param(owed)}::text[])`);
      for (const row of quantized)
        scored.push({ chunkId: row.chunkId, distance: int8Distance(embedding, norm, row.vector) });
      // A chunk the backfill has not reached yet is ordered by its half.
      const found = new Set(quantized.map((row) => row.chunkId));
      owed = owed.filter((chunkId) => !found.has(chunkId));
    }
    if (owed.length > 0) {
      const halves = await tx.execute<{ chunkId: string; distance: number }>(sql`
        select chunk_id as "chunkId", embedding <=> ${query}::halfvec(1024) as distance
        from clarity_search_chunk_vectors
        where chunk_id = any(${sql.param(owed)}::text[])
        order by distance, chunk_id
        limit ${count}`);
      for (const row of halves)
        scored.push({ chunkId: row.chunkId, distance: Number(row.distance) });
    }
    await tx.execute(sql.raw(`set local enable_indexscan = on`));
  }
  scored.sort(
    (left, right) =>
      left.distance - right.distance ||
      (left.chunkId < right.chunkId ? -1 : left.chunkId > right.chunkId ? 1 : 0),
  );

  const documentIds: string[] = [];
  const distances: number[] = [];
  for (const row of scored.slice(0, count)) {
    const documentId = documentOf.get(row.chunkId);
    if (documentId === undefined) continue;
    documentIds.push(documentId);
    distances.push(row.distance);
  }
  return { documentIds, distances };
}

/**
 * How long a hybrid search's semantic arm may run before the search ranks
 * lexically instead. Cold, in production, it takes under 1 s (2026-10-21).
 */
const SEMANTIC_ARM_TIMEOUT_MS = 4_000;

/**
 * {@link nearestChunks} for a hybrid search, which still has its lexical arm:
 * `undefined` when finding them runs past {@link SEMANTIC_ARM_TIMEOUT_MS}, so
 * the search answers lexically and says so instead of failing. Run in a
 * savepoint, so the cancelled statement leaves the transaction usable.
 */
export async function nearestChunksOrDegrade(
  tx: ClarityExecutor,
  embedding: readonly number[],
  count: number,
  /** A test seam. */
  { timeoutMs = SEMANTIC_ARM_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<NearestChunks | undefined> {
  try {
    return await tx.transaction(async (savepoint) => {
      await savepoint.execute(sql.raw(`set local statement_timeout = ${Math.trunc(timeoutMs)}`));
      const found = await nearestChunks(savepoint, embedding, count);
      // `set local` outlives the savepoint: the ranking gets its own bound back.
      await savepoint.execute(
        sql.raw(`set local statement_timeout = ${SEARCH_STATEMENT_TIMEOUT_MS}`),
      );
      return found;
    });
  } catch (error) {
    if (isStatementTimeout(error)) return undefined;
    throw error;
  }
}

/**
 * The nearest chunks as rows `nearest(document_id, distance)`, for a ranking
 * statement to group by document.
 */
export function nearestChunkRows({ documentIds, distances }: NearestChunks) {
  return sql`unnest(${sql.param(documentIds)}::text[], ${sql.param(distances)}::float8[]) as nearest(document_id, distance)`;
}
