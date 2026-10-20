/**
 * A document's page text lives in its chunks (docs/search-storage.md).
 *
 * Every indexed document is chunked from exactly the text it stores
 * (`chunkText`, 2,000 characters every 1,600), so the text is the chunks laid
 * end to end. `clarity_search_documents.main_content` keeps the text only when
 * the chunks cannot give it back: a document with no chunks (a `noindex` page)
 * or one whose text the chunks do not reproduce byte for byte. `chunkText`
 * slices by UTF-16 unit, so a cut through a surrogate pair stores a lone
 * surrogate, which Postgres keeps as U+FFFD; such a text stays stored.
 * Measured in production (2026-10-21): main_content averaged 2.8 KB over 1.3M
 * documents, all of it already in the chunks.
 */
import { asc, inArray } from 'drizzle-orm';

import type { ClarityExecutor } from '../db/index.js';
import { searchChunks } from '../db/schema/index.js';
import type { TextChunk } from './chunking.js';

/** The text as Postgres gives it back: a lone surrogate becomes U+FFFD. */
export function textAsStored(text: string): string {
  return Buffer.from(text, 'utf8').toString('utf8');
}

export interface StoredChunk {
  startOffset: number;
  text: string;
}

/** The text a document's chunks hold, laid end to end; chunks in position order. */
export function textFromChunks(chunks: readonly StoredChunk[]): string {
  let text = '';
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const next = chunks[index + 1];
    text += next ? chunk.text.slice(0, next.startOffset - chunk.startOffset) : chunk.text;
  }
  return text;
}

/**
 * What a writer stores in `main_content` for `text` chunked into `chunks`:
 * nothing when the stored chunks give the text back exactly, the text otherwise.
 */
export function mainContentToStore(
  text: string | null | undefined,
  chunks: readonly TextChunk[],
): string | null {
  if (text === null || text === undefined) return null;
  if (chunks.length === 0) return text;
  const exact =
    textAsStored(text) === text && chunks.every((chunk) => textAsStored(chunk.text) === chunk.text);
  return exact ? null : text;
}

/** Each document's text from its chunks, for documents that store none. */
export async function textOfChunkedDocuments(
  executor: ClarityExecutor,
  documentIds: readonly string[],
): Promise<Map<string, string>> {
  const byDocument = new Map<string, StoredChunk[]>();
  if (documentIds.length === 0) return new Map();
  const rows = await executor
    .select({
      documentId: searchChunks.documentId,
      startOffset: searchChunks.startOffset,
      text: searchChunks.text,
    })
    .from(searchChunks)
    .where(inArray(searchChunks.documentId, [...documentIds]))
    .orderBy(asc(searchChunks.documentId), asc(searchChunks.position));
  for (const row of rows) {
    const chunks = byDocument.get(row.documentId) ?? [];
    chunks.push(row);
    byDocument.set(row.documentId, chunks);
  }
  return new Map([...byDocument].map(([id, chunks]) => [id, textFromChunks(chunks)]));
}

/** The rows with `mainContent` filled from their chunks where it is not stored. */
export async function withPageText<T extends { id: string; mainContent: string | null }>(
  executor: ClarityExecutor,
  rows: readonly T[],
): Promise<T[]> {
  const missing = rows.filter((row) => row.mainContent === null).map((row) => row.id);
  const texts = await textOfChunkedDocuments(executor, missing);
  return rows.map((row) =>
    row.mainContent === null && texts.has(row.id)
      ? { ...row, mainContent: texts.get(row.id) ?? null }
      : row,
  );
}
