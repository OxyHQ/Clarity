/**
 * Gives every chunk embedded before the int8 store existed its int8 vector
 * (`clarity_search_chunk_int8_vectors`, docs/adr/0001-search-storage-diet.md,
 * phase 2), quantized from the half-precision vector it has: the bytes a new
 * embedding writes (chunking.ts `int8Base64`), and no Kaana call.
 *
 * Walks `clarity_search_chunk_vectors` in physical order, a range of heap
 * pages at a time (a TID range scan: sequential reads, no index), and inserts
 * what is missing. A chunk deleted meanwhile is skipped: its embeddings row is
 * key-share-locked, skipping any a concurrent re-chunk holds, as
 * `storeChunkEmbeddings` does. Idempotent and resumable from the page it logs;
 * paced by a duty cycle like the other one-shots. It deletes nothing.
 *
 *   bun packages/backend/dist/db/backfill-chunk-int8.js --target-database=clarity
 */
import { sql } from 'drizzle-orm';

import type { ClarityExecutor } from '../db/index.js';
import { halvesFromSend } from './half-precision.js';
import { int8Vector } from './semantic-rerank.js';

export interface Int8BackfillBatch {
  read: number;
  inserted: number;
}

/** One range of heap pages, `[firstPage, firstPage + pages)`. */
export async function backfillInt8Pages(
  db: ClarityExecutor,
  firstPage: number,
  pages: number,
): Promise<Int8BackfillBatch> {
  const rows = await db.execute<{ chunkId: string; half: Uint8Array }>(sql`
    select vector.chunk_id as "chunkId", halfvec_send(vector.embedding) as half
    from clarity_search_chunk_vectors as vector
    where vector.ctid >= ${`(${firstPage},0)`}::tid and vector.ctid < ${`(${firstPage + pages},0)`}::tid
      and not exists (
        select 1 from clarity_search_chunk_int8_vectors as quantized
        where quantized.chunk_id = vector.chunk_id
      )`);
  if (rows.length === 0) return { read: 0, inserted: 0 };
  const quantized = JSON.stringify(
    rows.map((row) => ({
      id: row.chunkId,
      int8: int8Vector(halvesFromSend(row.half)).toString('base64'),
    })),
  );
  const inserted = await db.execute<{ chunkId: string }>(sql`
    with present as materialized (
      select embedding.chunk_id
      from clarity_search_chunk_embeddings as embedding
      where embedding.chunk_id in (
        select id from jsonb_to_recordset(${quantized}::jsonb) as quantized(id text, int8 text)
      )
      order by embedding.chunk_id
      for key share of embedding skip locked
    )
    insert into clarity_search_chunk_int8_vectors (chunk_id, vector)
    select quantized.id, decode(quantized.int8, 'base64')
    from jsonb_to_recordset(${quantized}::jsonb) as quantized(id text, int8 text)
    inner join present on present.chunk_id = quantized.id
    on conflict (chunk_id) do nothing
    returning chunk_id as "chunkId"`);
  return { read: rows.length, inserted: inserted.length };
}

export interface Int8BackfillOptions {
  /** Heap pages a batch reads (~3 vectors a page). */
  pagesPerBatch: number;
  /** Fraction of wall time spent working; the rest is sleep (0 < dutyCycle ≤ 1). */
  dutyCycle: number;
  /** The page to start from: what a previous run logged as `nextPage`. */
  fromPage?: number;
  /** A canary run: stop after this many batches. */
  maxBatches?: number;
  log: (event: string, fields: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}

export async function backfillInt8Vectors(
  db: ClarityExecutor,
  options: Int8BackfillOptions,
): Promise<{ read: number; inserted: number; nextPage: number }> {
  const [{ pages }] = await db.execute<{ pages: number }>(sql`
    select (pg_relation_size('clarity_search_chunk_vectors') / current_setting('block_size')::int)::int as pages`);
  const total = { read: 0, inserted: 0, nextPage: options.fromPage ?? 0 };
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let batches = 1; total.nextPage < pages; batches += 1) {
    const started = Date.now();
    const batch = await backfillInt8Pages(db, total.nextPage, options.pagesPerBatch);
    total.read += batch.read;
    total.inserted += batch.inserted;
    total.nextPage += options.pagesPerBatch;
    if (batches % 100 === 0) options.log('progress', { ...total, pages });
    if (options.maxBatches !== undefined && batches >= options.maxBatches) break;
    const took = Date.now() - started;
    const rest = (took * (1 - options.dutyCycle)) / options.dutyCycle;
    if (rest > 0) await sleep(rest);
  }
  options.log('done', { ...total, pages });
  return total;
}
