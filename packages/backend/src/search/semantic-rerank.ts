/**
 * How the semantic arm orders the candidates the codes' HNSW index returns,
 * and which per-chunk vectors it keeps to order them by
 * (docs/adr/0001-search-storage-diet.md).
 *
 * `CLARITY_SEMANTIC_RERANK`:
 *
 * - `vectors` (the default): each candidate's half-precision vector
 *   (`clarity_search_chunk_vectors`: 2 KiB, 2.8 KiB a row on disk) is read and
 *   the candidates are ordered by exact cosine distance.
 * - `int8`: each candidate's int8 vector (`clarity_search_chunk_int8_vectors`,
 *   1 KiB) is read instead and they are ordered by its cosine distance. A
 *   candidate without one (the backfill has not reached it) is ordered by its
 *   half-precision vector, so the switch is safe before the backfill ends.
 *   Measured on production vectors and queries: the same nearest documents as
 *   `vectors` (nDCG@10 0.998 against it).
 * - `codes`: no vector is read; the candidates are ordered by the query's float
 *   vector against each code's signs. Measured: nDCG@10 0.78 against
 *   `vectors`. A lever for an instance short of IO, not a default.
 *
 * Every embedded chunk gets its int8 vector. Its half-precision vector stops
 * being written only when `CLARITY_STORE_CHUNK_VECTORS=false` AND the rerank
 * reads none (`int8` or `codes`): a chunk without one would be dropped by the
 * `vectors` rerank.
 */

/** The vectors' width: `halfvec(1024)`, `bit(1024)`, 1,024 int8s. */
export const VECTOR_DIMENSION = 1024;

export type SemanticRerank = 'vectors' | 'int8' | 'codes';

export function semanticRerank(env: NodeJS.ProcessEnv = process.env): SemanticRerank {
  const value = env.CLARITY_SEMANTIC_RERANK?.trim();
  return value === 'int8' || value === 'codes' ? value : 'vectors';
}

/** Whether embedding a chunk also writes its half-precision vector. */
export function storesChunkVectors(env: NodeJS.ProcessEnv = process.env): boolean {
  return !(
    env.CLARITY_STORE_CHUNK_VECTORS?.trim() === 'false' && semanticRerank(env) !== 'vectors'
  );
}

export function vectorNorm(vector: ArrayLike<number>): number {
  let sum = 0;
  for (let index = 0; index < vector.length; index++) sum += vector[index] * vector[index];
  return Math.sqrt(sum) || 1;
}

/**
 * A vector as 1,024 signed bytes: each element scaled by 127 / max|xᵢ| and
 * rounded. The scale is not kept: a cosine distance does not depend on it.
 */
export function int8Vector(values: ArrayLike<number>): Buffer {
  if (values.length !== VECTOR_DIMENSION)
    throw new Error(`An int8 vector has ${VECTOR_DIMENSION} elements, not ${values.length}`);
  let max = 0;
  for (let index = 0; index < values.length; index++) max = Math.max(max, Math.abs(values[index]));
  const bytes = Buffer.alloc(VECTOR_DIMENSION);
  if (!(max > 0) || !Number.isFinite(max)) return bytes;
  const scale = 127 / max;
  for (let index = 0; index < values.length; index++)
    bytes.writeInt8(Math.max(-127, Math.min(127, Math.round(values[index] * scale))), index);
  return bytes;
}

/** The cosine distance between `query` (its norm given) and an {@link int8Vector}. */
export function int8Distance(
  query: readonly number[],
  queryNorm: number,
  vector: Uint8Array,
): number {
  if (vector.length !== VECTOR_DIMENSION) throw new Error('An int8 vector is the wrong length');
  const signed = new Int8Array(vector.buffer, vector.byteOffset, vector.byteLength);
  let dot = 0;
  let norm = 0;
  for (let index = 0; index < VECTOR_DIMENSION; index++) {
    dot += query[index] * signed[index];
    norm += signed[index] * signed[index];
  }
  return 1 - dot / (queryNorm * (Math.sqrt(norm) || 1));
}

/**
 * The cosine distance a binary code puts a chunk at from `query`, estimated
 * from the query's float vector and the code's signs: `1 − q·s / (|q|·√D)`
 * with `s` the code as ±1. Only the order it gives is used (the rankings rank
 * documents by their nearest chunk).
 *
 * `code` is `varbit_send(code)`: a 4-byte big-endian bit count, then the bits,
 * the first dimension in the most significant bit of the first byte —
 * `binary_quantize` sets dimension i when its value is above zero.
 */
export function codeDistance(
  query: readonly number[],
  queryNorm: number,
  code: Uint8Array,
): number {
  if (code.length < 4 + VECTOR_DIMENSION / 8)
    throw new Error('A chunk code is shorter than its vector');
  let score = 0;
  for (let index = 0; index < VECTOR_DIMENSION; index++) {
    const set = (code[4 + (index >> 3)] >> (7 - (index & 7))) & 1;
    score += set ? query[index] : -query[index];
  }
  return 1 - score / (queryNorm * Math.sqrt(VECTOR_DIMENSION));
}
