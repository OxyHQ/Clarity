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

import { and, eq, isNull, ne, or, type SQL, sql } from 'drizzle-orm';

import { getDb, type ClarityExecutor } from '../db/index.js';
import { searchChunks, searchDocuments } from '../db/schema/index.js';
import {
  CLARITY_EMBEDDING_MODEL,
  createEmbeddings,
  embeddingsEnabled,
} from '../lib/kaana-embeddings.js';
import { createLogger } from '../lib/logger.js';
import { getRedisClient, withRedisTimeout } from '../lib/redis.js';
import { EmbeddingQueue, type PendingChunk } from './embedding-queue.js';

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

/** Writes the vectors of embedded chunks; a chunk replaced meanwhile is simply not found. */
export async function storeChunkEmbeddings(
  chunks: readonly PendingChunk[],
  embeddings: readonly number[][],
): Promise<void> {
  const rows = chunks.map(({ id }, index) => ({
    id,
    embedding: `[${embeddings[index].join(',')}]`,
  }));
  await getDb().execute(sql`
    update clarity_search_chunks as chunk
    set embedding = embedded.embedding::vector,
        embedding_model = ${CLARITY_EMBEDDING_MODEL},
        updated_at = now()
    from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as embedded(id text, embedding text)
    where chunk.id = embedded.id
  `);
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
      .where(
        and(
          eq(searchChunks.documentId, documentId),
          or(
            isNull(searchChunks.embedding),
            isNull(searchChunks.embeddingModel),
            ne(searchChunks.embeddingModel, CLARITY_EMBEDDING_MODEL),
          ),
        ),
      )
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

/**
 * SQL true when the document `documentId` names has no chunk still owed an
 * embedding by the current model (always true without the capability, which
 * never embeds). For a caller deciding whether re-indexing would queue any.
 */
export function noChunksOwedEmbedding(documentId: SQL): SQL {
  if (!embeddingsEnabled()) return sql`true`;
  return sql`not exists (
    select 1 from ${searchChunks}
    where ${searchChunks.documentId} = ${documentId}
      and (${searchChunks.embedding} is null or ${searchChunks.embeddingModel} is distinct from ${CLARITY_EMBEDDING_MODEL})
  )`;
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
  if (!document || document.mainContent !== mainContent) return 'stale';

  const [chunks] = await executor
    .select({
      total: sql<number>`count(*)::int`,
      extracted: sql<number>`(count(*) filter (
        where ${searchChunks.extractorVersion} = ${extractorVersion}
      ))::int`,
      embedded: sql<number>`(count(*) filter (
        where ${searchChunks.extractorVersion} = ${extractorVersion}
          and ${searchChunks.embeddingModel} = ${CLARITY_EMBEDDING_MODEL}
          and ${searchChunks.embedding} is not null
      ))::int`,
    })
    .from(searchChunks)
    .where(eq(searchChunks.documentId, document.id));
  if (!chunks || chunks.total !== chunkCount || chunks.extracted !== chunkCount) return 'stale';
  return chunks.embedded === chunkCount ? 'current' : 'unembedded';
}

/**
 * Replaces a document's chunks, unembedded unless `embeddings` are given; then
 * {@link queueChunkEmbeddings} embeds them once the transaction commits.
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
  await tx.insert(searchChunks).values(
    chunks.map((chunk, position) => ({
      id: crypto.randomUUID(),
      documentId,
      position,
      startOffset: chunk.start,
      endOffset: chunk.end,
      text: chunk.text,
      searchVector: sql`to_tsvector('simple', ${chunk.text})`,
      embedding: embeddings?.[position],
      embeddingModel: embeddings ? CLARITY_EMBEDDING_MODEL : undefined,
      extractorVersion,
    })),
  );
}
