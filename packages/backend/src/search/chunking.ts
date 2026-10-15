/**
 * Chunking and embedding for the shared search index.
 *
 * One definition used by the crawl worker and by API ingestion, so a document
 * that arrives through either path is chunked, embedded and stored identically
 * and therefore ranks identically.
 */
import { eq, sql } from 'drizzle-orm';

import type { ClarityExecutor } from '../db/index.js';
import { searchChunks, searchDocuments } from '../db/schema/index.js';
import {
  CLARITY_EMBEDDING_MODEL,
  createEmbeddings,
  embeddingsEnabled,
} from '../lib/kaana-embeddings.js';

const CHUNK_STRIDE = 1600;
const CHUNK_LENGTH = 2000;
const EMBEDDING_BATCH = 128;

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
 * The chunks' embeddings, or `undefined` when there are none to have: no chunk,
 * no embeddings capability (nothing is called), or a failed call (reported by
 * the client, rate-limited). Without embeddings the document stays lexically
 * searchable and its chunks are `unembedded`, so a later pass embeds them.
 */
export async function embedChunks(texts: readonly string[]): Promise<number[][] | undefined> {
  if (texts.length === 0 || !embeddingsEnabled()) return undefined;
  const embeddings: number[][] = [];
  try {
    for (let start = 0; start < texts.length; start += EMBEDDING_BATCH) {
      embeddings.push(...(await createEmbeddings(texts.slice(start, start + EMBEDDING_BATCH))));
    }
  } catch {
    return undefined;
  }
  return embeddings;
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
  try {
    const [embedding] = await createEmbeddings([query], signal ? { signal } : {});
    return embedding;
  } catch {
    return undefined;
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
 *   embedding. Only fresh embeddings would change anything.
 * - `stale`: anything else, including a document not indexed yet.
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
 * Whether replacing a document's chunks stores anything new. Chunks that are
 * already right except for their embeddings are only worth rewriting with
 * embeddings: while the embedding route failed, every feed poll deleted and
 * re-inserted the same unembedded chunks of every listing it re-delivered.
 */
export function chunksNeedReplacing(state: DocumentChunkState, embedded: boolean): boolean {
  return state === 'stale' || (state === 'unembedded' && embedded);
}

/** Replaces a document's chunks. Missing embeddings leave it lexically searchable. */
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
