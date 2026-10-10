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
import { CLARITY_EMBEDDING_MODEL, createOxyEmbeddings } from '../lib/oxy-embeddings.js';

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

export async function embedChunks(texts: readonly string[]): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH) {
    embeddings.push(...(await createOxyEmbeddings(texts.slice(start, start + EMBEDDING_BATCH))));
  }
  return embeddings;
}

/**
 * True when the document at `canonicalUrl` already indexes exactly
 * `mainContent`, chunked by `extractorVersion`, with every one of its
 * `chunkCount` chunks embedded by the current model — so re-chunking and
 * re-embedding it would reproduce what is stored.
 */
export async function documentChunksCurrent(
  executor: ClarityExecutor,
  canonicalUrl: string,
  mainContent: string,
  chunkCount: number,
  extractorVersion: string,
): Promise<boolean> {
  const [row] = await executor
    .select({
      mainContent: searchDocuments.mainContent,
      embedded: sql<number>`(
      select count(*)::int from ${searchChunks}
      where ${searchChunks.documentId} = ${searchDocuments.id}
        and ${searchChunks.extractorVersion} = ${extractorVersion}
        and ${searchChunks.embeddingModel} = ${CLARITY_EMBEDDING_MODEL}
        and ${searchChunks.embedding} is not null
    )`,
      total: sql<number>`(select count(*)::int from ${searchChunks} where ${searchChunks.documentId} = ${searchDocuments.id})`,
    })
    .from(searchDocuments)
    .where(eq(searchDocuments.canonicalUrl, canonicalUrl))
    .limit(1);
  return (
    Boolean(row) &&
    row.mainContent === mainContent &&
    row.embedded === chunkCount &&
    row.total === chunkCount
  );
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
