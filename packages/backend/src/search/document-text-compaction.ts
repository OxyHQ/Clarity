/**
 * Clears what `clarity_search_documents` stores twice (docs/search-storage.md):
 *
 * - `main_content` of a document whose chunks give it back exactly — every
 *   chunk is the text's slice at its offsets and the chunks laid end to end are
 *   the text (page-text.ts);
 * - the raw JSON-LD of every document but news (whose list falls back to it
 *   for a date the column lacks): no reader uses it — a job posting is
 *   projected once and sighted after (`recordJobSighting`) — and what a page
 *   states is already a column.
 *
 * A row is cleared only if it still holds what was read (compare-and-set on
 * both columns), so a crawl that rewrote it meanwhile wins. Idempotent and
 * paced like the chunk compaction: run once after the deploy that stops
 * writing these, run again if interrupted.
 *
 *   bun packages/backend/dist/db/compact-document-text.js --target-database=clarity
 */
import { sql } from 'drizzle-orm';

import type { ClarityExecutor } from '../db/index.js';
import { textFromChunks } from './page-text.js';

type DocumentRow = {
  id: string;
  document_type: string;
  main_content: string | null;
  structured_data: unknown;
  text_md5: string;
  data_md5: string;
};

type ChunkRow = {
  document_id: string;
  start_offset: number;
  end_offset: number;
  text: string;
};

/** Whether `chunks` (in position order) are `text`, exactly. */
export function chunksHoldText(text: string, chunks: readonly ChunkRow[]): boolean {
  if (chunks.length === 0) return false;
  for (const chunk of chunks) {
    if (chunk.text !== text.slice(chunk.start_offset, chunk.end_offset)) return false;
  }
  return (
    textFromChunks(
      chunks.map((chunk) => ({ startOffset: chunk.start_offset, text: chunk.text })),
    ) === text
  );
}

/** Whether a document's JSON-LD has a reader: a job posting's feed, or news. */
export function structuredDataIsRead(documentType: string): boolean {
  return documentType === 'news';
}

function isEmptyJsonLd(structuredData: unknown): boolean {
  return Array.isArray(structuredData) && structuredData.length === 0;
}

export interface DocumentBatch {
  last: string | null;
  read: number;
  clearedText: number;
  clearedData: number;
}

export async function compactDocumentBatch(
  db: ClarityExecutor,
  after: string | null,
  limit: number,
): Promise<DocumentBatch> {
  const rows = await db.execute<DocumentRow>(sql`
    select id, document_type, main_content, structured_data,
      md5(coalesce(main_content, '')) as text_md5, md5(structured_data::text) as data_md5
    from clarity_search_documents
    where ${after === null ? sql`true` : sql`id > ${after}`}
    order by id
    limit ${limit}`);
  if (rows.length === 0) return { last: null, read: 0, clearedText: 0, clearedData: 0 };

  const withText = rows.filter((row) => row.main_content !== null).map((row) => row.id);
  const chunks =
    withText.length === 0
      ? []
      : await db.execute<ChunkRow>(sql`
          select document_id, start_offset, end_offset, text from clarity_search_chunks
          where document_id in (${sql.join(
            withText.map((id) => sql`${id}`),
            sql`, `,
          )})
          order by document_id, position`);
  const chunksOf = new Map<string, ChunkRow[]>();
  for (const chunk of chunks) {
    const list = chunksOf.get(chunk.document_id) ?? [];
    list.push(chunk);
    chunksOf.set(chunk.document_id, list);
  }

  const updates = rows.flatMap((row) => {
    const clearText =
      row.main_content !== null && chunksHoldText(row.main_content, chunksOf.get(row.id) ?? []);
    const clearData =
      !isEmptyJsonLd(row.structured_data) && !structuredDataIsRead(row.document_type);
    return clearText || clearData
      ? [
          {
            id: row.id,
            clear_text: clearText,
            clear_data: clearData,
            text_md5: row.text_md5,
            data_md5: row.data_md5,
          },
        ]
      : [];
  });

  let clearedText = 0;
  let clearedData = 0;
  if (updates.length > 0) {
    const changed = await db.execute<{ clear_text: boolean; clear_data: boolean }>(sql`
      update clarity_search_documents as document set
        main_content = case when target.clear_text then null else document.main_content end,
        structured_data = case when target.clear_data then '[]'::jsonb else document.structured_data end
      from jsonb_to_recordset(${JSON.stringify(updates)}::jsonb)
        as target(id text, clear_text boolean, clear_data boolean, text_md5 text, data_md5 text)
      where document.id = target.id
        and md5(coalesce(document.main_content, '')) = target.text_md5
        and md5(document.structured_data::text) = target.data_md5
      returning target.clear_text, target.clear_data`);
    for (const row of changed) {
      if (row.clear_text) clearedText += 1;
      if (row.clear_data) clearedData += 1;
    }
  }
  return { last: rows[rows.length - 1].id, read: rows.length, clearedText, clearedData };
}

export interface DocumentCompactionOptions {
  batchSize: number;
  /** Fraction of wall time spent working; the rest is sleep (0 < dutyCycle ≤ 1). */
  dutyCycle: number;
  log: (event: string, fields: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}

export async function compactDocumentText(
  db: ClarityExecutor,
  options: DocumentCompactionOptions,
): Promise<{ read: number; clearedText: number; clearedData: number }> {
  const total = { read: 0, clearedText: 0, clearedData: 0 };
  let after: string | null = null;
  for (let batches = 1; ; batches += 1) {
    const started = Date.now();
    const batch = await compactDocumentBatch(db, after, options.batchSize);
    total.read += batch.read;
    total.clearedText += batch.clearedText;
    total.clearedData += batch.clearedData;
    if (batches % 100 === 0) options.log('progress', { ...total, last: batch.last });
    if (batch.read < options.batchSize || batch.last === null) break;
    after = batch.last;
    const took = Date.now() - started;
    const rest = (took * (1 - options.dutyCycle)) / options.dutyCycle;
    if (rest > 0) await (options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(rest);
  }
  options.log('done', total);
  return total;
}
