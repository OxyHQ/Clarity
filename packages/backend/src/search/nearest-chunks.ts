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
 */
import { sql } from 'drizzle-orm';

import type { ClarityExecutor } from '../db/index.js';

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
): Promise<NearestChunks> {
  const query = JSON.stringify(embedding);
  const pool = count * CANDIDATE_OVERSAMPLING;
  // `set local` takes no bind parameter; every value is a module constant or
  // derived from one.
  await tx.execute(sql.raw(`set local hnsw.ef_search = ${Math.min(pool, EF_SEARCH_CEILING)}`));
  // A pool past `ef_search` is read by resuming the scan, in approximately
  // ascending order; the exact distance reorders it below anyway.
  await tx.execute(sql.raw(`set local hnsw.iterative_scan = relaxed_order`));
  const candidates = await tx.execute<{ chunkId: string; documentId: string }>(sql`
    select chunk_id as "chunkId", document_id as "documentId"
    from clarity_search_chunk_embeddings
    order by code <~> binary_quantize(${query}::halfvec(1024))::bit(1024)
    limit ${pool}`);
  if (candidates.length === 0) return { documentIds: [], distances: [] };

  const documentOf = new Map(candidates.map((row) => [row.chunkId, row.documentId]));
  // An index scan would read the vectors one page at a time, in candidate
  // order; the bitmap scan reads them in physical order and ahead.
  await tx.execute(sql.raw(`set local enable_indexscan = off`));
  await tx.execute(sql.raw(`set local effective_io_concurrency = ${VECTOR_READ_CONCURRENCY}`));
  const nearest = await tx.execute<{ chunkId: string; distance: number }>(sql`
    select chunk_id as "chunkId", embedding <=> ${query}::halfvec(1024) as distance
    from clarity_search_chunk_vectors
    where chunk_id = any(${sql.param(candidates.map((row) => row.chunkId))}::text[])
    order by distance, chunk_id
    limit ${count}`);
  await tx.execute(sql.raw(`set local enable_indexscan = on`));

  const documentIds: string[] = [];
  const distances: number[] = [];
  for (const row of nearest) {
    const documentId = documentOf.get(row.chunkId);
    if (documentId === undefined) continue;
    documentIds.push(documentId);
    distances.push(Number(row.distance));
  }
  return { documentIds, distances };
}

/**
 * The nearest chunks as rows `nearest(document_id, distance)`, for a ranking
 * statement to group by document.
 */
export function nearestChunkRows({ documentIds, distances }: NearestChunks) {
  return sql`unnest(${sql.param(documentIds)}::text[], ${sql.param(distances)}::float8[]) as nearest(document_id, distance)`;
}
