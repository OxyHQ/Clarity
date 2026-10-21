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

import { and, eq, gt, inArray, isNull, ne, or, type SQL, sql } from 'drizzle-orm';

import { getDb, type ClarityExecutor } from '../db/index.js';
import { searchChunkEmbeddings, searchChunks, searchDocuments } from '../db/schema/index.js';
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
 * (docs/search-storage.md, "Vectors"). Two narrow rows; the chunk row is not
 * touched. A chunk replaced meanwhile is simply not found, and one another
 * worker already embedded with the current model is not rewritten. Vectors go
 * as the halves the column stores (half-precision.ts), not Kaana's float text.
 */
export async function storeChunkEmbeddings(
  chunks: readonly PendingChunk[],
  embeddings: readonly number[][],
): Promise<void> {
  const rows = chunks.map(({ id }, index) => ({
    id,
    embedding: halfVectorText(embeddings[index]),
  }));
  await getDb().execute(sql`
    with embedded as (
      select id, embedding::halfvec(1024) as embedding
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as embedded(id text, embedding text)
    ), coded as (
      update clarity_search_chunk_embeddings as chunk
      set code = binary_quantize(embedded.embedding)::bit(1024),
          model = ${CLARITY_EMBEDDING_MODEL}
      from embedded
      where chunk.chunk_id = embedded.id
        and (chunk.code is null or chunk.model is distinct from ${CLARITY_EMBEDDING_MODEL})
      returning chunk.chunk_id
    )
    insert into clarity_search_chunk_vectors (chunk_id, embedding)
    select embedded.id, embedded.embedding from embedded
    inner join coded on coded.chunk_id = embedded.id
    on conflict (chunk_id) do update set embedding = excluded.embedding
  `);
}

/** The backlog sweep tops the queue up only while it holds fewer chunks than this. */
const BACKLOG_IDLE_PENDING = 256;
/** Chunks the backlog sweep queues at a time (once a minute: ~8 vector writes a second). */
export const BACKLOG_BATCH = 512;
/** Where the sweep resumes; a random start keeps several workers apart. */
let backlogCursor: string | null = crypto.randomUUID();

/**
 * Queues the next unembedded chunks, in id order through
 * `clarity_search_chunk_embeddings_unembedded_idx` (no scan): the backlog is embedded at
 * a steady pace instead of whenever its documents are indexed again — which
 * made every feed poll re-project each listing still owed a vector. Freshly
 * indexed documents keep the queue first: the sweep waits while it is busy.
 */
export async function queueEmbeddingBacklog(): Promise<number> {
  if (!embeddingsEnabled()) return 0;
  if (chunkEmbeddingQueue().pending >= BACKLOG_IDLE_PENDING) return 0;
  const after = backlogCursor;
  // The ids first, then their text by key. Joined in one statement, the
  // planner merged the partial index with the chunks' primary key from its
  // start, reading every chunk below the cursor — 409k pages, 6.5 s, every
  // minute (production, 2026-10-21).
  const owed = await getDb()
    .select({ id: searchChunkEmbeddings.chunkId })
    .from(searchChunkEmbeddings)
    .where(
      and(
        isNull(searchChunkEmbeddings.code),
        after === null ? undefined : gt(searchChunkEmbeddings.chunkId, after),
      ),
    )
    .orderBy(searchChunkEmbeddings.chunkId)
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
      .innerJoin(searchChunkEmbeddings, eq(searchChunkEmbeddings.chunkId, searchChunks.id))
      .where(
        and(
          eq(searchChunks.documentId, documentId),
          or(
            isNull(searchChunkEmbeddings.code),
            ne(searchChunkEmbeddings.model, CLARITY_EMBEDDING_MODEL),
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
      embeddingModel: searchChunkEmbeddings.model,
      embedded: sql<boolean>`${searchChunkEmbeddings.code} is not null`,
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
  return chunks.every((chunk) => chunk.embedded && chunk.embeddingModel === CLARITY_EMBEDDING_MODEL)
    ? 'current'
    : 'unembedded';
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
  // Every chunk has its embeddings row, NULL until embedded: the backlog sweep
  // finds what is owed there. Upserted, not inserted: while the split copy's
  // trigger (0050) is installed, the chunk insert above has already written it.
  await tx.execute(sql`
    insert into clarity_search_chunk_embeddings (chunk_id, document_id, code, model)
    select coded.id, coded.document_id,
      binary_quantize(coded.embedding::halfvec(1024))::bit(1024),
      case when coded.embedding is null then null else ${CLARITY_EMBEDDING_MODEL} end
    from jsonb_to_recordset(${JSON.stringify(rows.map(({ id, embedding }) => ({ id, document_id: documentId, embedding })))}::jsonb)
      as coded(id text, document_id text, embedding text)
    on conflict (chunk_id) do update set
      document_id = excluded.document_id, code = excluded.code, model = excluded.model`);
  const vectors = rows.filter((row) => row.embedding !== null);
  if (vectors.length > 0)
    await tx.execute(sql`
      insert into clarity_search_chunk_vectors (chunk_id, embedding)
      select vector.id, vector.embedding::halfvec(1024)
      from jsonb_to_recordset(${JSON.stringify(vectors.map(({ id, embedding }) => ({ id, embedding })))}::jsonb)
        as vector(id text, embedding text)
      on conflict (chunk_id) do update set embedding = excluded.embedding`);
}
