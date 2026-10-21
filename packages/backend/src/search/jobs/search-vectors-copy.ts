/**
 * Copies each listing's full-text vector into `clarity_job_search_vectors`,
 * the inline table that replaces `clarity_job_postings.search_vector`
 * (migration 0054, docs/jobs.mdx "The lexical arm, in two phases").
 *
 * Migration 0054's trigger writes every vector inserted or changed since it
 * committed; this copies the listings that predate it, in id order,
 * `ON CONFLICT DO NOTHING` — a row the trigger wrote is newer and wins, and a
 * listing changed while a batch read it is rewritten by its trigger after.
 * Then it checks the counts in one snapshot, builds the GIN index
 * CONCURRENTLY and records the copy, which the switch requires. Idempotent
 * and paced; run once after the deploy that carries 0054:
 *
 *   bun packages/backend/dist/db/copy-job-search-vectors.js --target-database=clarity
 */
import { sql } from 'drizzle-orm';

import type { ClarityExecutor } from '../../db/index.js';

export async function copyJobSearchVectorsBatch(
  db: ClarityExecutor,
  after: string | null,
  limit: number,
): Promise<{ last: string | null; read: number }> {
  const [row] = await db.execute<{ last: string | null; read: string }>(sql`
    with batch as (
      select id, search_vector from clarity_job_postings
      where ${after === null ? sql`true` : sql`id > ${after}`}
      order by id
      limit ${limit}
    ), copied as (
      insert into clarity_job_search_vectors (job_posting_id, search_vector)
      select id, search_vector from batch
      on conflict (job_posting_id) do nothing
      returning 1
    )
    select (select max(id) from batch) as last, (select count(*) from batch) as read`);
  return { last: row?.last ?? null, read: Number(row?.read ?? 0) };
}

export async function countJobSearchVectors(
  db: ClarityExecutor,
): Promise<{ listings: number; vectors: number }> {
  const [row] = await db.execute<{ listings: string; vectors: string }>(sql`
    select (select count(*) from clarity_job_postings) as listings,
      (select count(*) from clarity_job_search_vectors) as vectors`);
  return { listings: Number(row?.listings ?? 0), vectors: Number(row?.vectors ?? 0) };
}

/** Under the name the schema gives it. CONCURRENTLY: the trigger keeps writing. */
export const SEARCH_VECTORS_INDEX = `create index concurrently if not exists clarity_job_search_vectors_search_idx on clarity_job_search_vectors using gin (search_vector)`;

export async function buildJobSearchVectorsIndex(db: ClarityExecutor): Promise<void> {
  // A build interrupted part-way leaves an INVALID index that IF NOT EXISTS
  // would pass over: drop it so it is built again.
  await db.execute(sql`
    do $$
    declare invalid record;
    begin
      for invalid in
        select c.relname from pg_index i join pg_class c on c.oid = i.indexrelid
        where i.indrelid = 'clarity_job_search_vectors'::regclass and not i.indisvalid
      loop
        execute format('drop index %I', invalid.relname);
      end loop;
    end $$`);
  await db.execute(sql.raw(SEARCH_VECTORS_INDEX));
}

export interface SearchVectorsCopyOptions {
  batchSize: number;
  /** Fraction of wall time spent working; the rest is sleep (0 < dutyCycle ≤ 1). */
  dutyCycle: number;
  log: (event: string, fields: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}

export async function copyJobSearchVectors(
  db: ClarityExecutor,
  options: SearchVectorsCopyOptions,
): Promise<{ read: number; listings: number }> {
  let after: string | null = null;
  let read = 0;
  for (let batches = 1; ; batches += 1) {
    const started = Date.now();
    const batch = await copyJobSearchVectorsBatch(db, after, options.batchSize);
    read += batch.read;
    if (batches % 100 === 0) options.log('progress', { read, last: batch.last });
    if (batch.read < options.batchSize || batch.last === null) break;
    after = batch.last;
    const took = Date.now() - started;
    const rest = (took * (1 - options.dutyCycle)) / options.dutyCycle;
    if (rest > 0) await (options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(rest);
  }
  // In one snapshot: the trigger writes a listing's vector in the listing's
  // own transaction, and a deleted listing's cascades, so the counts agree
  // once the copy is complete.
  const counts = await countJobSearchVectors(db);
  if (counts.vectors !== counts.listings) {
    throw new Error(
      `${counts.listings} listings, ${counts.vectors} vectors: not recorded. Run again.`,
    );
  }
  options.log('counted', counts);
  await buildJobSearchVectorsIndex(db);
  options.log('indexed', {});
  await db.execute(sql`
    insert into clarity_job_search_vectors_copy (id, rows) values (1, ${counts.listings})
    on conflict (id) do update set rows = excluded.rows, completed_at = now()`);
  options.log('recorded', counts);
  return { read, listings: counts.listings };
}
