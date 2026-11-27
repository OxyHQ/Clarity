/**
 * Chunking and embedding for the shared search index.
 *
 * One definition used by the crawl worker and by API ingestion, so a document
 * that arrives through either path is chunked, embedded and stored identically
 * and therefore ranks identically.
 *
 * Indexing never waits on Kaana: a document's chunks are stored unembedded and
 * queued ({@link queueChunkEmbeddings}), and the queue embeds chunks from many
 * documents per request and writes the vectors back (`embedding-queue.ts`).
 */
import { createHash } from 'node:crypto';

import { and, eq, gt, inArray, not, sql } from 'drizzle-orm';

import { getDb, type ClarityExecutor } from '../db/index.js';
import {
  searchChunkBacklog,
  searchChunkEmbeddings,
  searchChunks,
  searchDocuments,
} from '../db/schema/index.js';
import {
  CLARITY_EMBEDDING_MODEL,
  createEmbeddings,
  embeddingsEnabled,
} from '../lib/kaana-embeddings.js';
import { createLogger } from '../lib/logger.js';
import { getRedisClient, withRedisTimeout } from '../lib/redis.js';
import { EmbeddingQueue, type PendingChunk } from './embedding-queue.js';
import { halfVectorText } from './half-precision.js';
import { textFromChunks } from './page-text.js';

const CHUNK_STRIDE = 1600;
const CHUNK_LENGTH = 2000;

const log = createLogger('embeddings');

export interface TextChunk {
  start: number;
  end: number;
  text: string;
}

export function chunkText(text: string): TextChunk[] {
  const result: TextChunk[] = [];
  for (let start = 0; start < text.length; start += CHUNK_STRIDE) {
    const end = Math.min(start + CHUNK_LENGTH, text.length);
    result.push({ start, end, text: text.slice(start, end) });
  }
  return result;
}

/**
 * Writes the vectors of embedded chunks: the binary code the semantic index
 * holds and the half-precision vector a search reorders by
 * (docs/search-storage.md, "Vectors"), and takes the chunks off the backlog.
 * One statement, which:
 *
 * 1. key-share-locks the chunks that still exist, in id order, skipping any a
 *    concurrent re-chunk or delete has locked: a chunk replaced meanwhile is
 *    simply not found, and the store never waits on (or deadlocks with) the
 *    transaction replacing it. Chunks first, as every other writer locks them,
 *    so the embeddings, vector and backlog rows below cannot be deleted under
 *    it;
 * 2. INSERTS each chunk's embeddings row. A row already current is not
 *    rewritten; only a row from another model (or a NULL code the previous
 *    image left, until migration 0064 moves those) is updated, so the table
 *    under the HNSW index stays insert-only (docs/search-storage.md,
 *    "Insert-only codes");
 * 3. writes the vectors of the rows actually written;
 * 4. deletes the chunks' backlog rows.
 *
 * Vectors go as the halves the column stores (half-precision.ts), not Kaana's
 * float text.
 */
export async function storeChunkEmbeddings(
  chunks: readonly PendingChunk[],
  embeddings: readonly number[][],
  /** A test seam: the cycle is measured inside one transaction. */
  executor: ClarityExecutor = getDb(),
): Promise<void> {
  const rows = chunks.map(({ id }, index) => ({
    id,
    embedding: halfVectorText(embeddings[index]),
  }));
  await executor.execute(sql`
    with embedded as (
      select distinct on (id) id, embedding::halfvec(1024) as embedding
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as embedded(id text, embedding text)
      order by id
    ), owed as materialized (
      select chunk.id, chunk.document_id
      from clarity_search_chunks as chunk
      where chunk.id in (select id from embedded)
      order by chunk.id
      for key share of chunk skip locked
    ), coded as (
      insert into clarity_search_chunk_embeddings as stored (chunk_id, document_id, code, model)
      select owed.id, owed.document_id, binary_quantize(embedded.embedding)::bit(1024),
        ${CLARITY_EMBEDDING_MODEL}
      from owed
      inner join embedded on embedded.id = owed.id
      order by owed.id
      on conflict (chunk_id) do update set
        document_id = excluded.document_id, code = excluded.code, model = excluded.model
      where stored.code is null or stored.model is distinct from excluded.model
      returning stored.chunk_id
    ), drained as (
      delete from clarity_search_chunk_backlog as owing
      using owed
      where owing.chunk_id = owed.id
    )
    insert into clarity_search_chunk_vectors (chunk_id, embedding)
    select embedded.id, embedded.embedding from embedded
    inner join coded on coded.chunk_id = embedded.id
    on conflict (chunk_id) do update set embedding = excluded.embedding
  `);
}

/** The backlog sweep tops the queue up only while it holds fewer chunks than this. */
const BACKLOG_IDLE_PENDING = 1_024;
/**
 * Chunks the backlog sweep queues at a time, once a minute: more than the
 * queue embeds in a minute (embedding-queue.ts `MAX_IN_FLIGHT`), so Kaana's
 * pace — not the sweep's — sets the backlog's.
 */
export const BACKLOG_BATCH = 2_048;
/** Where the sweep resumes; a random start keeps several workers apart. */
let backlogCursor: string | null = crypto.randomUUID();

/**
 * Queues the next chunks owed an embedding, in id order through the
 * backlog's primary key (no scan): the backlog is embedded at a steady pace
 * instead of whenever its documents are indexed again — which made every feed
 * poll re-project each listing still owed a vector. Freshly indexed documents
 * keep the queue first: the sweep waits while it is busy.
 */
export async function queueEmbeddingBacklog(): Promise<number> {
  if (!embeddingsEnabled()) return 0;
  if (chunkEmbeddingQueue().pending >= BACKLOG_IDLE_PENDING) return 0;
  const after = backlogCursor;
  // The ids first, then their text by key. Joined in one statement, the
  // planner merged the owed ids with the chunks' primary key from its start,
  // reading every chunk below the cursor — 409k pages, 6.5 s, every minute
  // (production, 2026-10-21).
  const owed = await getDb()
    .select({ id: searchChunkBacklog.chunkId })
    .from(searchChunkBacklog)
    .where(after === null ? undefined : gt(searchChunkBacklog.chunkId, after))
    .orderBy(searchChunkBacklog.chunkId)
    .limit(BACKLOG_BATCH);
  const ids = owed.map((row) => row.id);
  const rows =
    ids.length === 0
      ? []
      : await getDb()
          .select({ id: searchChunks.id, text: searchChunks.text })
          .from(searchChunks)
          .where(inArray(searchChunks.id, ids))
          .orderBy(searchChunks.id);
  backlogCursor = ids.length < BACKLOG_BATCH ? null : (ids[ids.length - 1] ?? null);
  chunkEmbeddingQueue().enqueue(rows);
  return rows.length;
}

let queue: EmbeddingQueue | undefined;

function chunkEmbeddingQueue(): EmbeddingQueue {
  queue ??= new EmbeddingQueue({
    embed: (texts) => createEmbeddings(texts, { queued: true }),
    store: storeChunkEmbeddings,
    onStoreFailure: (error, chunks) =>
      log.warn(
        { chunks, error: error instanceof Error ? error.message : String(error) },
        'Chunk embeddings could not be stored; the chunks stay unembedded',
      ),
  });
  return queue;
}

/** Test seam: sends every queued chunk embedding now. */
export async function flushChunkEmbeddingsForTests(): Promise<void> {
  await queue?.flush();
}

/**
 * Whether a chunk, left-joined to its embeddings row, carries an embedding by
 * the current model. A chunk without a row is owed one (it is in the backlog),
 * and so, until migration 0064 moves them, is one whose row the previous image
 * left with a NULL code and model.
 */
const currentEmbedding = sql<boolean>`coalesce(${searchChunkEmbeddings.model} = ${CLARITY_EMBEDDING_MODEL}, false)`;

/**
 * Queues the chunks of a document that lack a current embedding: called after
 * the transaction that stored them commits. Nothing is read or queued without
 * the embeddings capability. Best effort: the document is already indexed and
 * lexically searchable, and its chunks are queued again whenever it is indexed
 * again.
 */
export async function queueChunkEmbeddings(documentId: string): Promise<void> {
  if (!embeddingsEnabled()) return;
  try {
    const chunks = await getDb()
      .select({ id: searchChunks.id, text: searchChunks.text })
      .from(searchChunks)
      .leftJoin(searchChunkEmbeddings, eq(searchChunkEmbeddings.chunkId, searchChunks.id))
      .where(and(eq(searchChunks.documentId, documentId), not(currentEmbedding)))
      .orderBy(searchChunks.position);
    chunkEmbeddingQueue().enqueue(chunks);
  } catch (error) {
    log.warn(
      { documentId, error: error instanceof Error ? error.message : String(error) },
      'Could not queue chunk embeddings; they are queued when the document is indexed again',
    );
  }
}

/**
 * A search query's embedding, or `undefined` when hybrid or semantic ranking
 * cannot have one: no embeddings capability (nothing is called) or a failed
 * call. The caller ranks lexically and says so, or refuses a semantic search.
 */
export async function embedQuery(
  query: string,
  signal?: AbortSignal,
): Promise<number[] | undefined> {
  if (!embeddingsEnabled()) return undefined;
  const cached = await cachedQueryEmbedding(query);
  if (cached) return cached;
  try {
    const [embedding] = await createEmbeddings([query], signal ? { signal } : {});
    if (embedding) void cacheQueryEmbedding(query, embedding);
    return embedding;
  } catch {
    return undefined;
  }
}

/**
 * A query's embedding depends only on the model and the text, so it is kept
 * in Redis for a week: a repeated search (pagination, a popular query, the
 * jobs and web verticals asking for the same words) skips Kaana's round trip
 * — up to the 2.5 s a search waits for it — and its cost. Stored as float32,
 * the precision the half-precision index compares at and more. Best effort:
 * without Redis, or when it is slow, the embedding is simply requested.
 */
const QUERY_EMBEDDING_TTL_SECONDS = 7 * 24 * 60 * 60;
const QUERY_EMBEDDING_REDIS_TIMEOUT_MS = 150;

function queryEmbeddingKey(query: string): string {
  const digest = createHash('sha256').update(`${CLARITY_EMBEDDING_MODEL}\n${query}`).digest('hex');
  return `clarity:query-embedding:${digest}`;
}

async function cachedQueryEmbedding(query: string): Promise<number[] | undefined> {
  const redis = getRedisClient();
  if (!redis) return undefined;
  try {
    const stored = await withRedisTimeout(
      redis.getBuffer(queryEmbeddingKey(query)),
      QUERY_EMBEDDING_REDIS_TIMEOUT_MS,
    );
    if (!stored || stored.byteLength % 4 !== 0) return undefined;
    const vector = new Float32Array(
      stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength),
    );
    return Array.from(vector);
  } catch {
    return undefined;
  }
}

async function cacheQueryEmbedding(query: string, embedding: readonly number[]): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    const bytes = Buffer.from(new Float32Array(embedding).buffer);
    await withRedisTimeout(
      redis.set(queryEmbeddingKey(query), bytes, 'EX', QUERY_EMBEDDING_TTL_SECONDS),
    );
  } catch {
    // A cache that cannot be written is only a cache miss next time.
  }
}

export type DocumentChunkState = 'current' | 'unembedded' | 'stale';

/**
 * How the chunks stored for the document at `canonicalUrl` compare with
 * chunking `mainContent` by `extractorVersion` into `chunkCount` chunks:
 *
 * - `current`: the same text and extractor, and every chunk embedded by the
 *   current model. Re-chunking and re-embedding would reproduce what is stored.
 * - `unembedded`: the same chunks, but not all of them carry a current
 *   embedding. They are kept, and only their embeddings are queued.
 * - `stale`: anything else, including a document not indexed yet. Only these
 *   chunks are replaced.
 *
 * Two statements, not one with correlated subqueries: Drizzle renders the
 * columns of a single-table select unqualified, so a subquery comparing
 * `searchChunks.documentId` with `searchDocuments.id` became
 * `"document_id" = "id"`, which Postgres binds to the CHUNK's own id. That
 * matched nothing, so every call sequentially scanned the whole chunks table
 * twice and reported the document stale, re-embedding it on every feed poll.
 */
export async function documentChunkState(
  executor: ClarityExecutor,
  canonicalUrl: string,
  mainContent: string,
  chunkCount: number,
  extractorVersion: string,
): Promise<DocumentChunkState> {
  const [document] = await executor
    .select({ id: searchDocuments.id, mainContent: searchDocuments.mainContent })
    .from(searchDocuments)
    .where(eq(searchDocuments.canonicalUrl, canonicalUrl))
    .limit(1);
  if (!document) return 'stale';

  const chunks = await executor
    .select({
      startOffset: searchChunks.startOffset,
      text: searchChunks.text,
      extractorVersion: searchChunks.extractorVersion,
      embedded: currentEmbedding,
    })
    .from(searchChunks)
    .leftJoin(searchChunkEmbeddings, eq(searchChunkEmbeddings.chunkId, searchChunks.id))
    .where(eq(searchChunks.documentId, document.id))
    .orderBy(searchChunks.position);
  // A chunked document stores no text of its own: its text is its chunks'
  // (page-text.ts).
  const stored = document.mainContent ?? textFromChunks(chunks);
  if (stored !== mainContent) return 'stale';
  if (
    chunks.length !== chunkCount ||
    chunks.some((chunk) => chunk.extractorVersion !== extractorVersion)
  )
    return 'stale';
  return chunks.every((chunk) => chunk.embedded) ? 'current' : 'unembedded';
}

/**
 * Replaces a document's chunks, unembedded unless `embeddings` are given; then
 * {@link queueChunkEmbeddings} embeds them once the transaction commits. An
 * embedded chunk gets its embeddings row and vector; one without goes into the
 * backlog. No embeddings row is written before its code exists, so none is
 * ever updated into one (docs/search-storage.md, "Insert-only codes").
 */
export async function replaceDocumentChunks(
  tx: ClarityExecutor,
  documentId: string,
  chunks: readonly TextChunk[],
  embeddings: number[][] | undefined,
  extractorVersion: string,
): Promise<void> {
  await tx.delete(searchChunks).where(eq(searchChunks.documentId, documentId));
  if (chunks.length === 0) return;
  const rows = chunks.map((chunk, position) => ({
    id: crypto.randomUUID(),
    documentId,
    position,
    startOffset: chunk.start,
    endOffset: chunk.end,
    text: chunk.text,
    extractorVersion,
    embedding: embeddings?.[position] ? halfVectorText(embeddings[position]) : null,
  }));
  await tx.insert(searchChunks).values(rows.map(({ embedding: _, ...row }) => row));
  const owed = rows.filter((row) => row.embedding === null);
  if (owed.length > 0)
    await tx.insert(searchChunkBacklog).values(owed.map(({ id }) => ({ chunkId: id, documentId })));
  const vectors = rows.filter((row) => row.embedding !== null);
  if (vectors.length === 0) return;
  const embedded = JSON.stringify(vectors.map(({ id, embedding }) => ({ id, embedding })));
  await tx.execute(sql`
    insert into clarity_search_chunk_embeddings (chunk_id, document_id, code, model)
    select coded.id, ${documentId},
      binary_quantize(coded.embedding::halfvec(1024))::bit(1024), ${CLARITY_EMBEDDING_MODEL}
    from jsonb_to_recordset(${embedded}::jsonb) as coded(id text, embedding text)`);
  await tx.execute(sql`
    insert into clarity_search_chunk_vectors (chunk_id, embedding)
    select vector.id, vector.embedding::halfvec(1024)
    from jsonb_to_recordset(${embedded}::jsonb) as vector(id text, embedding text)`);
}
