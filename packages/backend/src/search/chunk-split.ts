/**
 * Copies `clarity_search_chunks` into the layout it is swapped for (migration
 * 0050, docs/search-storage.md "The split"): the chunk without its vector
 * (`clarity_search_chunks_compact`), the vector's binary code
 * (`clarity_search_chunk_embeddings`) and the vector itself
 * (`clarity_search_chunk_vectors`).
 *
 * Migration 0050's trigger mirrors every write made since it committed; this
 * copies the rows that existed before. Run once, as a one-shot
 * (`db/split-search-chunks`), after the deploy that carries 0050:
 *
 *   1. copy the live rows in id order, `ON CONFLICT DO NOTHING` — a row the
 *      trigger already wrote is newer and wins;
 *   2. delete every copied row whose chunk the live table no longer has (a
 *      chunk deleted after a batch read it and before the batch wrote it comes
 *      back otherwise);
 *   3. compare the counts in one snapshot;
 *   4. build the indexes CONCURRENTLY, add the foreign keys and validate them;
 *   5. record the result, which the swap migration requires.
 *
 * Every step is idempotent, so an interrupted run is simply run again. It is
 * paced: after each batch it sleeps as long as the batch took (`dutyCycle`
 * 0.5), so it never takes more than half of what the shared instance gives one
 * connection.
 */
import { sql } from 'drizzle-orm';

import type { ClarityExecutor } from '../db/index.js';

export interface CopiedBatch {
  /** The last live id the batch read; the next batch starts after it. */
  last: string | null;
  /** Live rows the batch read (a full batch means there may be more). */
  read: number;
}

/** Copies the next `limit` live chunks after `after` into the three tables. */
export async function copySplitBatch(
  db: ClarityExecutor,
  after: string | null,
  limit: number,
): Promise<CopiedBatch> {
  const [row] = await db.execute<{ last: string | null; read: string }>(sql`
    with batch as (
      select id, document_id, position, start_offset, end_offset, text, embedding,
        embedding_model, extractor_version, created_at, updated_at
      from clarity_search_chunks
      where ${after === null ? sql`true` : sql`id > ${after}`}
      order by id
      limit ${limit}
    ), chunks as (
      insert into clarity_search_chunks_compact (
        id, document_id, position, start_offset, end_offset, text,
        extractor_version, created_at, updated_at
      )
      select id, document_id, position, start_offset, end_offset, text,
        extractor_version, created_at, updated_at
      from batch
      on conflict do nothing
      returning 1
    ), codes as (
      insert into clarity_search_chunk_embeddings (chunk_id, document_id, code, model)
      select id, document_id, binary_quantize(embedding)::bit(1024),
        case when embedding is null then null else embedding_model end
      from batch
      on conflict do nothing
      returning 1
    ), vectors as (
      insert into clarity_search_chunk_vectors (chunk_id, embedding)
      select id, embedding from batch where embedding is not null
      on conflict do nothing
      returning 1
    )
    select (select max(id) from batch) as last, (select count(*) from batch) as read`);
  return { last: row?.last ?? null, read: Number(row?.read ?? 0) };
}

/** The copies, each by the column that names its chunk. */
export const SPLIT_TABLES = [
  { table: 'clarity_search_chunk_vectors', key: 'chunk_id' },
  { table: 'clarity_search_chunk_embeddings', key: 'chunk_id' },
  { table: 'clarity_search_chunks_compact', key: 'id' },
] as const;

type SplitTable = (typeof SPLIT_TABLES)[number];

/**
 * Deletes copied rows of `copy` after `after` (up to `limit` of its keys) whose
 * chunk the live table no longer holds. Returns the last key examined.
 */
export async function pruneSplitOrphans(
  db: ClarityExecutor,
  copy: SplitTable,
  after: string | null,
  limit: number,
): Promise<{ last: string | null; examined: number; deleted: number }> {
  const table = sql.raw(copy.table);
  const key = sql.raw(copy.key);
  const [row] = await db.execute<{ last: string | null; examined: string; deleted: string }>(sql`
    with window_keys as (
      select ${key} as id from ${table}
      where ${after === null ? sql`true` : sql`${key} > ${after}`}
      order by ${key}
      limit ${limit}
    ), removed as (
      delete from ${table} c
      using window_keys w
      where c.${key} = w.id
        and not exists (select 1 from clarity_search_chunks live where live.id = w.id)
      returning 1
    )
    select (select max(id) from window_keys) as last,
      (select count(*) from window_keys) as examined,
      (select count(*) from removed) as deleted`);
  return {
    last: row?.last ?? null,
    examined: Number(row?.examined ?? 0),
    deleted: Number(row?.deleted ?? 0),
  };
}

export interface SplitCounts {
  live: number;
  embedded: number;
  chunks: number;
  codes: number;
  coded: number;
  vectors: number;
}

/** Every count the copy must match, read in one statement (one snapshot). */
export async function countSplit(db: ClarityExecutor): Promise<SplitCounts> {
  const [row] = await db.execute<Record<keyof SplitCounts, string>>(sql`
    select (select count(*) from clarity_search_chunks) as live,
      (select count(*) from clarity_search_chunks where embedding is not null) as embedded,
      (select count(*) from clarity_search_chunks_compact) as chunks,
      (select count(*) from clarity_search_chunk_embeddings) as codes,
      (select count(*) from clarity_search_chunk_embeddings where code is not null) as coded,
      (select count(*) from clarity_search_chunk_vectors) as vectors`);
  return {
    live: Number(row?.live ?? 0),
    embedded: Number(row?.embedded ?? 0),
    chunks: Number(row?.chunks ?? 0),
    codes: Number(row?.codes ?? 0),
    coded: Number(row?.coded ?? 0),
    vectors: Number(row?.vectors ?? 0),
  };
}

export function splitCountsMatch(counts: SplitCounts): boolean {
  return (
    counts.chunks === counts.live &&
    counts.codes === counts.live &&
    counts.coded === counts.embedded &&
    counts.vectors === counts.embedded
  );
}

/**
 * The copies' indexes, under the names the swap keeps. CONCURRENTLY: the
 * trigger keeps writing while they build. Must run outside a transaction.
 */
export const SPLIT_INDEX_STATEMENTS = [
  `create index concurrently if not exists clarity_search_chunks_compact_text_fts_idx on clarity_search_chunks_compact using gin (to_tsvector('simple'::regconfig, text))`,
  `create index concurrently if not exists clarity_search_chunk_embeddings_code_hnsw_idx on clarity_search_chunk_embeddings using hnsw (code bit_hamming_ops)`,
] as const;

/**
 * The foreign keys, in the order they depend on each other: the chunk on its
 * document, the code on its chunk, the vector on its code. Each cascades, so
 * deleting a document or a chunk deletes everything below it.
 */
export const SPLIT_FOREIGN_KEYS = [
  {
    table: 'clarity_search_chunks_compact',
    name: 'clarity_search_chunks_compact_document_fk',
    definition:
      'foreign key (document_id) references clarity_search_documents(id) on delete cascade',
  },
  {
    table: 'clarity_search_chunk_embeddings',
    name: 'clarity_search_chunk_embeddings_chunk_fk',
    definition:
      'foreign key (chunk_id) references clarity_search_chunks_compact(id) on delete cascade',
  },
  {
    table: 'clarity_search_chunk_vectors',
    name: 'clarity_search_chunk_vectors_chunk_fk',
    definition:
      'foreign key (chunk_id) references clarity_search_chunk_embeddings(chunk_id) on delete cascade',
  },
] as const;

export async function buildSplitIndexes(db: ClarityExecutor): Promise<void> {
  // A build interrupted part-way leaves an INVALID index that IF NOT EXISTS
  // would pass over: drop it so it is built again.
  await db.execute(sql`
    do $$
    declare invalid record;
    begin
      for invalid in
        select c.relname from pg_index i join pg_class c on c.oid = i.indexrelid
        where i.indrelid in (
          'clarity_search_chunks_compact'::regclass,
          'clarity_search_chunk_embeddings'::regclass,
          'clarity_search_chunk_vectors'::regclass
        ) and not i.indisvalid
      loop
        execute format('drop index %I', invalid.relname);
      end loop;
    end $$`);
  for (const statement of SPLIT_INDEX_STATEMENTS) await db.execute(sql.raw(statement));
  for (const key of SPLIT_FOREIGN_KEYS) {
    await db.execute(
      sql.raw(`
      do $$
      begin
        if not exists (select 1 from pg_constraint where conname = '${key.name}') then
          alter table ${key.table} add constraint ${key.name} ${key.definition} not valid;
        end if;
      end $$`),
    );
    await db.execute(sql.raw(`alter table ${key.table} validate constraint ${key.name}`));
  }
}

export async function recordSplit(db: ClarityExecutor, rows: number): Promise<void> {
  await db.execute(sql`
    insert into clarity_search_chunk_split (id, rows, completed_at)
    values (1, ${rows}, now())
    on conflict (id) do update set rows = excluded.rows, completed_at = excluded.completed_at`);
}

export interface SplitOptions {
  batchSize: number;
  /** Fraction of wall time spent working; the rest is sleep (0 < dutyCycle ≤ 1). */
  dutyCycle: number;
  log: (event: string, fields: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}

async function paced<T>(options: SplitOptions, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await work();
  const took = Date.now() - started;
  const rest = (took * (1 - options.dutyCycle)) / options.dutyCycle;
  if (rest > 0) await (options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(rest);
  return result;
}

/** Steps 1–5. Refuses to record a copy whose counts differ. */
export async function splitSearchChunks(
  db: ClarityExecutor,
  options: SplitOptions,
): Promise<{ rows: number; pruned: number }> {
  let after: string | null = null;
  let copiedRead = 0;
  for (let batches = 1; ; batches += 1) {
    const batch = await paced(options, () => copySplitBatch(db, after, options.batchSize));
    copiedRead += batch.read;
    if (batches % 100 === 0) options.log('copy', { read: copiedRead, last: batch.last });
    if (batch.read < options.batchSize || batch.last === null) break;
    after = batch.last;
  }
  options.log('copied', { read: copiedRead });

  let pruned = 0;
  for (const copy of SPLIT_TABLES) {
    after = null;
    for (;;) {
      const window = await paced(options, () =>
        pruneSplitOrphans(db, copy, after, options.batchSize),
      );
      pruned += window.deleted;
      if (window.examined < options.batchSize || window.last === null) break;
      after = window.last;
    }
  }
  options.log('pruned', { pruned });

  const counts = await countSplit(db);
  if (!splitCountsMatch(counts)) {
    throw new Error(
      `The split copy does not match the live table (${JSON.stringify(counts)}): not recorded. Run again.`,
    );
  }
  options.log('counted', { ...counts });

  await buildSplitIndexes(db);
  options.log('indexed', {});

  await recordSplit(db, counts.live);
  options.log('recorded', { rows: counts.live });
  return { rows: counts.live, pruned };
}
