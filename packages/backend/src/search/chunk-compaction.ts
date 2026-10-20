/**
 * Copies `clarity_search_chunks` into `clarity_search_chunks_compact`, the
 * layout it is swapped for: embeddings at half precision and no stored
 * full-text vector (migration 0041, docs/search-storage.md).
 *
 * Migration 0041's trigger mirrors every write made since it committed; this
 * copies the rows that existed before. Run once, as a one-shot
 * (`db/compact-search-chunks`), after the deploy that carries 0041:
 *
 *   1. copy the live rows in id order, `ON CONFLICT DO NOTHING` — a row the
 *      trigger already wrote is newer and wins;
 *   2. delete every copied row the live table no longer has (a row deleted
 *      after a batch read it and before the batch wrote it comes back
 *      otherwise);
 *   3. compare the two counts in one snapshot;
 *   4. build the copy's indexes CONCURRENTLY and validate its foreign key;
 *   5. record the result, which the swap migration requires.
 *
 * Every step is idempotent, so an interrupted run is simply run again. The
 * copy is paced: after each batch it sleeps as long as the batch took
 * (`dutyCycle` 0.5), so it never takes more than half of what the shared
 * instance gives one connection.
 */
import { sql } from 'drizzle-orm';

import type { ClarityExecutor } from '../db/index.js';

export const COMPACT_TABLE = 'clarity_search_chunks_compact';

const COPY_COLUMNS = sql.raw(
  'id, document_id, position, start_offset, end_offset, text, embedding, embedding_model, extractor_version, created_at, updated_at',
);

export interface CopiedBatch {
  /** The last live id the batch read; the next batch starts after it. */
  last: string | null;
  /** Live rows the batch read (a full batch means there may be more). */
  read: number;
}

/** Copies the next `limit` live chunks after `after` that the copy lacks. */
export async function copyChunkBatch(
  db: ClarityExecutor,
  after: string | null,
  limit: number,
): Promise<CopiedBatch> {
  const [row] = await db.execute<{ last: string | null; read: string }>(sql`
    with batch as (
      select ${COPY_COLUMNS} from clarity_search_chunks
      where ${after === null ? sql`true` : sql`id > ${after}`}
      order by id
      limit ${limit}
    ), copied as (
      insert into clarity_search_chunks_compact (${COPY_COLUMNS})
      select id, document_id, position, start_offset, end_offset, text,
        embedding::halfvec(1024), embedding_model, extractor_version, created_at, updated_at
      from batch
      on conflict do nothing
      returning 1
    )
    select (select max(id) from batch) as last, (select count(*) from batch) as read`);
  return { last: row?.last ?? null, read: Number(row?.read ?? 0) };
}

/**
 * Deletes copied chunks after `after` (up to `limit` of the copy's ids) that
 * the live table no longer holds. Returns the last copied id examined.
 */
export async function pruneCopiedOrphans(
  db: ClarityExecutor,
  after: string | null,
  limit: number,
): Promise<{ last: string | null; examined: number; deleted: number }> {
  const [row] = await db.execute<{ last: string | null; examined: string; deleted: string }>(sql`
    with window_ids as (
      select id from clarity_search_chunks_compact
      where ${after === null ? sql`true` : sql`id > ${after}`}
      order by id
      limit ${limit}
    ), removed as (
      delete from clarity_search_chunks_compact c
      using window_ids w
      where c.id = w.id
        and not exists (select 1 from clarity_search_chunks live where live.id = w.id)
      returning 1
    )
    select (select max(id) from window_ids) as last,
      (select count(*) from window_ids) as examined,
      (select count(*) from removed) as deleted`);
  return {
    last: row?.last ?? null,
    examined: Number(row?.examined ?? 0),
    deleted: Number(row?.deleted ?? 0),
  };
}

/** Both row counts, read in one statement (one snapshot). */
export async function countChunkCopy(
  db: ClarityExecutor,
): Promise<{ live: number; copied: number }> {
  const [row] = await db.execute<{ live: string; copied: string }>(sql`
    select (select count(*) from clarity_search_chunks) as live,
      (select count(*) from clarity_search_chunks_compact) as copied`);
  return { live: Number(row?.live ?? 0), copied: Number(row?.copied ?? 0) };
}

/**
 * The copy's indexes and foreign key, under the names the swap gives them back.
 * CONCURRENTLY: the trigger keeps writing to the copy while they build. Must
 * run outside a transaction.
 */
export const COMPACT_INDEX_STATEMENTS = [
  `create index concurrently if not exists clarity_search_chunks_compact_text_fts_idx on clarity_search_chunks_compact using gin (to_tsvector('simple'::regconfig, text))`,
  `create index concurrently if not exists clarity_search_chunks_compact_embedding_halfvec_hnsw_idx on clarity_search_chunks_compact using hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops)`,
] as const;

const COMPACT_FOREIGN_KEY = 'clarity_search_chunks_compact_document_fk';

export async function buildCompactIndexes(db: ClarityExecutor): Promise<void> {
  // A build interrupted part-way leaves an INVALID index that IF NOT EXISTS
  // would pass over: drop it so it is built again.
  await db.execute(sql`
    do $$
    declare invalid record;
    begin
      for invalid in
        select c.relname from pg_index i join pg_class c on c.oid = i.indexrelid
        where i.indrelid = 'clarity_search_chunks_compact'::regclass and not i.indisvalid
      loop
        execute format('drop index %I', invalid.relname);
      end loop;
    end $$`);
  for (const statement of COMPACT_INDEX_STATEMENTS) await db.execute(sql.raw(statement));
  await db.execute(sql`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = ${sql.raw(`'${COMPACT_FOREIGN_KEY}'`)}) then
        alter table clarity_search_chunks_compact
          add constraint ${sql.raw(COMPACT_FOREIGN_KEY)} foreign key (document_id)
          references clarity_search_documents(id) on delete cascade not valid;
      end if;
    end $$`);
  await db.execute(
    sql.raw(`alter table clarity_search_chunks_compact validate constraint ${COMPACT_FOREIGN_KEY}`),
  );
}

export async function recordCompaction(db: ClarityExecutor, rows: number): Promise<void> {
  await db.execute(sql`
    insert into clarity_search_chunk_compaction (id, rows, completed_at)
    values (1, ${rows}, now())
    on conflict (id) do update set rows = excluded.rows, completed_at = excluded.completed_at`);
}

export interface CompactionOptions {
  batchSize: number;
  /** Fraction of wall time spent working; the rest is sleep (0 < dutyCycle ≤ 1). */
  dutyCycle: number;
  log: (event: string, fields: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}

async function paced<T>(options: CompactionOptions, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await work();
  const took = Date.now() - started;
  const rest = (took * (1 - options.dutyCycle)) / options.dutyCycle;
  if (rest > 0) await (options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(rest);
  return result;
}

/** Steps 1–5. Refuses to record a copy whose counts differ. */
export async function compactSearchChunks(
  db: ClarityExecutor,
  options: CompactionOptions,
): Promise<{ rows: number; pruned: number }> {
  let after: string | null = null;
  let copiedRead = 0;
  for (let batches = 1; ; batches += 1) {
    const batch = await paced(options, () => copyChunkBatch(db, after, options.batchSize));
    copiedRead += batch.read;
    if (batches % 100 === 0) options.log('copy', { read: copiedRead, last: batch.last });
    if (batch.read < options.batchSize || batch.last === null) break;
    after = batch.last;
  }
  options.log('copied', { read: copiedRead });

  after = null;
  let pruned = 0;
  for (;;) {
    const window = await paced(options, () => pruneCopiedOrphans(db, after, options.batchSize));
    pruned += window.deleted;
    if (window.examined < options.batchSize || window.last === null) break;
    after = window.last;
  }
  options.log('pruned', { pruned });

  const counts = await countChunkCopy(db);
  if (counts.live !== counts.copied) {
    throw new Error(
      `The copy holds ${counts.copied} chunks and the live table ${counts.live}: not recorded. Run again.`,
    );
  }
  options.log('counted', counts);

  await buildCompactIndexes(db);
  options.log('indexed', {});

  await recordCompaction(db, counts.live);
  options.log('recorded', { rows: counts.live });
  return { rows: counts.live, pruned };
}
