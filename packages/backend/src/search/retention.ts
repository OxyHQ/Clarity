/**
 * Retention for what grows without being read (docs/search-storage.md,
 * "Retention"). A draft for the owner: deleting production data is the
 * owner's decision, and nothing here runs on its own — it is the one-shot
 * `db/search-retention` (scripts/search-retention.ts), dry-run by default.
 *
 * Three targets, each a batched, keyed, resumable walk:
 *
 * - `crawl` — the crawl audit of finished operations older than the window:
 *   crawl pages (with their fetch attempts) and the operations left without
 *   pages. Kept: anything of an operation still queued or running, `removal`
 *   operations, and the newest page of every URL that is a job document's
 *   requested URL, because job recrawls are queued under the owner of that
 *   page's operation (worker.ts `enqueueJobRecrawls`); only its fetch attempts
 *   go. Usage events are not touched: they are the metering ledger and the
 *   idempotency guard of `consumeUsage` (search/quotas.ts).
 * - `job-vectors` — the half-precision vectors of dead job documents' chunks
 *   (`clarity_search_chunk_vectors`, a btree-only table, cheap to vacuum).
 *   The codes, chunks and documents stay; a search's candidate whose vector is
 *   gone is simply not reordered into the results (nearest-chunks.ts).
 * - `job-documents` — dead job documents themselves, as the worker's 90-day
 *   pass does (`pruneInactiveJobDocuments`), with a shorter window: listings,
 *   chunks, codes, vectors, signatures, term bands, headlines, search vectors,
 *   reports and feed links go by cascade, and their clusters re-elect.
 *
 * A job document is dead when its retention clock (`coalesce(fetched_at,
 * updated_at)`, the expression `clarity_search_documents_job_retention_idx`
 * holds) is older than the window, and none of its listings is active, seen
 * within the window, or in a status outside the allowed set (closed, expired,
 * removed; plus stale with `includeStale`).
 *
 * Every batch is one short transaction that re-evaluates the selection and
 * locks with `skip locked`, so a run is idempotent and can be stopped at any
 * point; the cursor it logs resumes it, and a run from the start is correct
 * too. A dry run reads in read-only transactions and reports the rows and
 * estimated bytes each table would lose.
 */
import { sql } from 'drizzle-orm';

import type { ClarityExecutor } from '../db/index.js';
import { electCanonical } from './jobs/projection.js';
import {
  BatchPacer,
  insideWindow,
  msUntilWindow,
  type OffPeakWindow,
  type PacingOptions,
} from './retention-pacing.js';

export type RetentionTarget = 'crawl' | 'job-vectors' | 'job-documents';
export const RETENTION_TARGETS: readonly RetentionTarget[] = [
  'crawl',
  'job-vectors',
  'job-documents',
];

/** The proposed window, in days (docs/search-storage.md, "Retention"). */
export const DEFAULT_RETENTION_DAYS = 30;
/** Nothing younger is ever deleted, whatever the operator passes. */
export const MIN_RETENTION_DAYS = 7;

/** Listing statuses a dead job document may have; `stale` only when asked. */
export const DEAD_LISTING_STATUSES = ['closed', 'expired', 'removed'] as const;
/** Crawl operation statuses that will never change again. */
const TERMINAL_CRAWL_OPERATIONS = ['succeeded', 'partial', 'failed', 'cancelled'];
/**
 * Crawl page statuses the walk visits, through `clarity_crawl_pages_lease_idx`
 * (status, available_at). Queued and retry pages are visited for operations
 * that ended without them (cancelled, failed); a leased (`fetching`) page never.
 */
const CRAWL_PAGE_STATUSES = ['failed', 'succeeded', 'queued', 'retry'] as const;

/** The semantic index a purge of codes leaves full of deleted elements. */
export const CODES_HNSW_INDEX = 'clarity_search_chunk_embeddings_code_hnsw_idx';

const STATEMENT_TIMEOUT = '60s';
const LOCK_TIMEOUT = '5s';

/** Tables a target deletes from, by the name each count is reported under. */
const JOB_DOCUMENT_TABLES = [
  'clarity_search_documents',
  'clarity_search_chunks',
  'clarity_search_chunk_embeddings',
  'clarity_search_chunk_vectors',
  'clarity_job_postings',
  'clarity_job_search_vectors',
  'clarity_job_posting_signatures',
  'clarity_job_term_bands',
  'clarity_job_headlines',
  'clarity_job_reports',
  'clarity_job_feed_listings',
  'clarity_search_document_urls',
  'clarity_search_outgoing_links',
] as const;
/**
 * The embedding backlog a concurrent change moves unembedded chunks into
 * (perf/hnsw-insert-only). Counted only where it exists, so the job works on
 * either layout; it cascades from its chunk like the embeddings row does.
 */
const CHUNK_BACKLOG_TABLE = 'clarity_search_chunk_backlog';
const CRAWL_TABLES = ['clarity_crawl_jobs', 'clarity_crawl_pages', 'clarity_fetch_attempts'];

export interface RetentionOptions {
  target: RetentionTarget;
  retentionDays: number;
  /** Job targets: a stale listing (not re-observed) counts as dead too. */
  includeStale?: boolean;
  /** False (the default) is a dry run: nothing is written. */
  execute?: boolean;
  /** The clock the cutoff is taken from (tests); defaults to now. */
  now?: Date;
  /** A cursor a previous run logged, to resume after it. */
  after?: string | null;
  /** Stop after this many batches (a canary run). */
  maxBatches?: number;
  /** Work only inside this window; null works at any hour. */
  window: OffPeakWindow | null;
  pacing: PacingOptions;
  log: (event: string, fields: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Wall clock for the window (tests). */
  clock?: () => Date;
}

export interface RetentionReport {
  target: RetentionTarget;
  execute: boolean;
  cutoff: string;
  batches: number;
  /** Where to resume; null when the walk reached its end. */
  cursor: string | null;
  complete: boolean;
  stoppedBy?: 'window' | 'max-batches';
  /** Rows deleted (or that a dry run would delete), per table. */
  rows: Record<string, number>;
  /** Rows the selection reached but keeps, by reason. */
  kept: Record<string, number>;
  /** Rows × the table's average row size (heap, TOAST and indexes). */
  estimatedBytes: Record<string, number>;
  totalEstimatedBytes: number;
  /** Binary codes removed from the semantic index (HNSW) by this run. */
  codesDeleted: number;
}

interface BatchResult {
  cursor: string | null;
  scanned: number;
  rows: Record<string, number>;
  kept: Record<string, number>;
  codesDeleted: number;
}

function add(into: Record<string, number>, from: Record<string, number>): void {
  for (const [key, value] of Object.entries(from)) into[key] = (into[key] ?? 0) + value;
}

function cutoffOf(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

/** Whether `table` exists here with a `chunk_id` column (the backlog layout). */
async function hasChunkColumn(db: ClarityExecutor, table: string): Promise<boolean> {
  const [row] = await db.execute<{ present: boolean }>(sql`
    select exists (
      select 1 from information_schema.columns
      where table_schema = current_schema() and table_name = ${table} and column_name = 'chunk_id'
    ) as present`);
  return Boolean(row?.present);
}

/** Average bytes a row of each table occupies: total relation size over its row estimate. */
export async function averageRowBytes(
  db: ClarityExecutor,
  tables: readonly string[],
): Promise<Record<string, number>> {
  const rows = await db.execute<{ name: string; bytes: number }>(sql`
    select c.relname as name,
      case when c.reltuples > 0 then pg_total_relation_size(c.oid)::float8 / c.reltuples else 0 end as bytes
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = current_schema() and c.relkind = 'r'
      and c.relname = any(${sql.param([...tables])}::text[])`);
  return Object.fromEntries(rows.map((row) => [row.name, Number(row.bytes)]));
}

async function startBatch(tx: ClarityExecutor, execute: boolean): Promise<void> {
  if (!execute) await tx.execute(sql`set transaction read only`);
  await tx.execute(sql.raw(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`));
  await tx.execute(sql.raw(`set local lock_timeout = '${LOCK_TIMEOUT}'`));
}

const ids = (values: readonly string[]) => sql`${sql.param([...values])}::text[]`;

// ---------------------------------------------------------------------------
// Dead job documents

/** A job document's retention clock: the expression its retention index holds. */
const jobClock = sql.raw('coalesce(d.fetched_at, d.updated_at)');

function parseJobCursor(cursor: string | null | undefined): { clock: string; id: string } | null {
  if (!cursor) return null;
  const split = cursor.lastIndexOf('|');
  if (split < 1) throw new Error(`Not a job retention cursor: ${cursor}`);
  return { clock: cursor.slice(0, split), id: cursor.slice(split + 1) };
}

/**
 * The next `limit` job documents past the cursor whose clock ran out, in clock
 * order through `clarity_search_documents_job_retention_idx`, and which of
 * them are dead. The cursor moves past every document read, dead or not, so a
 * batch reads at most `limit` documents.
 */
async function deadJobDocuments(
  tx: ClarityExecutor,
  input: {
    cutoff: Date;
    after: { clock: string; id: string } | null;
    limit: number;
    allowed: readonly string[];
    lock: boolean;
  },
): Promise<{ scanned: { id: string; clock: string }[]; dead: string[] }> {
  const cutoff = input.cutoff.toISOString();
  const scanned = await tx.execute<{ id: string; clock: string }>(sql`
    select d.id, ${jobClock}::text as clock
    from clarity_search_documents d
    where d.document_type = 'job'
      and ${jobClock} < ${cutoff}::timestamptz
      ${
        input.after
          ? sql`and ${jobClock} >= ${input.after.clock}::timestamptz
              and (${jobClock} > ${input.after.clock}::timestamptz or d.id > ${input.after.id})`
          : sql``
      }
    order by ${jobClock}, d.id
    limit ${input.limit}`);
  if (scanned.length === 0) return { scanned: [], dead: [] };
  const dead = await tx.execute<{ id: string }>(sql`
    select d.id from clarity_search_documents d
    where d.id = any(${ids(scanned.map((row) => row.id))})
      and d.document_type = 'job'
      and ${jobClock} < ${cutoff}::timestamptz
      and not exists (
        select 1 from clarity_job_postings p
        where p.document_id = d.id
          and (p.status = 'active'
            or p.last_seen_at >= ${cutoff}::timestamptz
            or p.status <> all(${ids(input.allowed)}))
      )
    order by d.id
    ${input.lock ? sql`for update of d skip locked` : sql``}`);
  return { scanned: [...scanned], dead: dead.map((row) => row.id) };
}

/** Rows each table would lose with these documents, counted before anything is deleted. */
async function jobDocumentRows(
  tx: ClarityExecutor,
  documentIds: readonly string[],
  withBacklog: boolean,
): Promise<Record<string, number> & { codes: number }> {
  const [row] = await tx.execute<Record<string, string | number>>(sql`
    with docs as (select unnest(${ids(documentIds)}) as id),
    postings as (
      select p.id from clarity_job_postings p where p.document_id in (select id from docs)
    ),
    chunks as (
      select c.id from clarity_search_chunks c where c.document_id in (select id from docs)
    )
    select
      (select count(*) from docs) as clarity_search_documents,
      (select count(*) from chunks) as clarity_search_chunks,
      (select count(*) from clarity_search_chunk_embeddings e where e.chunk_id in (select id from chunks)) as clarity_search_chunk_embeddings,
      (select count(*) from clarity_search_chunk_embeddings e where e.chunk_id in (select id from chunks) and e.code is not null) as codes,
      (select count(*) from clarity_search_chunk_vectors v where v.chunk_id in (select id from chunks)) as clarity_search_chunk_vectors,
      ${
        withBacklog
          ? sql`(select count(*) from ${sql.identifier(CHUNK_BACKLOG_TABLE)} b where b.chunk_id in (select id from chunks)) as ${sql.identifier(CHUNK_BACKLOG_TABLE)},`
          : sql``
      }
      (select count(*) from postings) as clarity_job_postings,
      (select count(*) from clarity_job_search_vectors x where x.job_posting_id in (select id from postings)) as clarity_job_search_vectors,
      (select count(*) from clarity_job_posting_signatures x where x.job_posting_id in (select id from postings)) as clarity_job_posting_signatures,
      (select count(*) from clarity_job_term_bands x where x.job_posting_id in (select id from postings)) as clarity_job_term_bands,
      (select count(*) from clarity_job_headlines x where x.job_posting_id in (select id from postings)) as clarity_job_headlines,
      (select count(*) from clarity_job_reports x where x.job_posting_id in (select id from postings)) as clarity_job_reports,
      (select count(*) from clarity_job_feed_listings x where x.document_id in (select id from docs)) as clarity_job_feed_listings,
      (select count(*) from clarity_search_document_urls x where x.document_id in (select id from docs)) as clarity_search_document_urls,
      (select count(*) from clarity_search_outgoing_links x where x.source_document_id in (select id from docs)) as clarity_search_outgoing_links`);
  const counts = Object.fromEntries(
    Object.entries(row ?? {}).map(([key, value]) => [key, Number(value)]),
  ) as Record<string, number> & { codes: number };
  return counts;
}

async function jobBatch(
  db: ClarityExecutor,
  input: {
    target: 'job-vectors' | 'job-documents';
    execute: boolean;
    cutoff: Date;
    after: string | null;
    limit: number;
    allowed: readonly string[];
    withBacklog: boolean;
  },
): Promise<BatchResult> {
  return db.transaction(async (tx) => {
    await startBatch(tx, input.execute);
    const { scanned, dead } = await deadJobDocuments(tx, {
      cutoff: input.cutoff,
      after: parseJobCursor(input.after),
      limit: input.limit,
      allowed: input.allowed,
      lock: input.execute,
    });
    const last = scanned.at(-1);
    const cursor = last ? `${last.clock}|${last.id}` : null;
    const keptDocuments = scanned.length - dead.length;
    if (dead.length === 0)
      return {
        cursor,
        scanned: scanned.length,
        rows: {},
        kept: { job_documents_alive: keptDocuments },
        codesDeleted: 0,
      };

    if (input.target === 'job-vectors') {
      const [counted] = await tx.execute<{ vectors: number }>(
        input.execute
          ? sql`with gone as (
              delete from clarity_search_chunk_vectors v using clarity_search_chunks c
              where c.document_id = any(${ids(dead)}) and v.chunk_id = c.id
              returning 1)
            select count(*)::int as vectors from gone`
          : sql`select count(*)::int as vectors
            from clarity_search_chunks c join clarity_search_chunk_vectors v on v.chunk_id = c.id
            where c.document_id = any(${ids(dead)})`,
      );
      return {
        cursor,
        scanned: scanned.length,
        rows: { clarity_search_chunk_vectors: Number(counted?.vectors ?? 0) },
        kept: { job_documents_alive: keptDocuments, job_documents_vectors_only: dead.length },
        codesDeleted: 0,
      };
    }

    const { codes, ...rows } = await jobDocumentRows(tx, dead, input.withBacklog);
    if (input.execute) {
      const clusters = await tx.execute<{ cluster_id: string }>(sql`
        select distinct cluster_id from clarity_job_postings
        where document_id = any(${ids(dead)}) and cluster_id is not null`);
      await tx.execute(sql`delete from clarity_search_documents where id = any(${ids(dead)})`);
      for (const { cluster_id } of clusters) await electCanonical(tx, cluster_id);
    }
    return {
      cursor,
      scanned: scanned.length,
      rows,
      kept: { job_documents_alive: keptDocuments },
      codesDeleted: codes,
    };
  });
}

// ---------------------------------------------------------------------------
// Crawl audit

function parseCrawlCursor(cursor: string | null | undefined): {
  status: (typeof CRAWL_PAGE_STATUSES)[number];
  at: string | null;
  id: string | null;
} {
  if (!cursor) return { status: CRAWL_PAGE_STATUSES[0], at: null, id: null };
  const [status, at, id] = cursor.split('|');
  if (!CRAWL_PAGE_STATUSES.includes(status as never) || at === undefined || id === undefined)
    throw new Error(`Not a crawl retention cursor: ${cursor}`);
  return { status: status as (typeof CRAWL_PAGE_STATUSES)[number], at, id };
}

/**
 * Whether a crawl page's operation is over and old enough, and whether the
 * page is the newest of a job document's requested URL (the recrawl origin,
 * worker.ts `enqueueJobRecrawls`: its newest page by `created_at`).
 */
function crawlEligibility(page: string, job: string, cutoff: string) {
  const p = sql.raw(page);
  const j = sql.raw(job);
  return {
    eligible: sql`(${p}.updated_at < ${cutoff}::timestamptz
      and ${p}.available_at < ${cutoff}::timestamptz
      and ${p}.status <> 'fetching'
      and ${j}.status = any(${ids(TERMINAL_CRAWL_OPERATIONS)})
      and ${j}.kind <> 'removal'
      and coalesce(${j}.finished_at, ${j}.updated_at) < ${cutoff}::timestamptz)`,
    origin: sql`(exists (
        select 1 from clarity_search_documents d
        where d.requested_url = ${p}.url and d.document_type = 'job')
      and not exists (
        select 1 from clarity_crawl_pages newer
        where newer.url = ${p}.url and newer.created_at > ${p}.created_at))`,
  };
}

async function crawlBatch(
  db: ClarityExecutor,
  input: {
    execute: boolean;
    cutoff: Date;
    after: string | null;
    limit: number;
    countedJobs: Set<string>;
  },
): Promise<BatchResult> {
  const cutoff = input.cutoff.toISOString();
  return db.transaction(async (tx) => {
    await startBatch(tx, input.execute);
    let position = parseCrawlCursor(input.after);
    let scanned: { id: string; at: string }[] = [];
    // One status at a time, each a range of the lease index; the cursor moves
    // to the next status when one is exhausted.
    for (;;) {
      scanned = [
        ...(await tx.execute<{ id: string; at: string }>(sql`
          select p.id, p.available_at::text as at from clarity_crawl_pages p
          where p.status = ${position.status}
            and p.available_at < ${cutoff}::timestamptz
            ${
              position.at !== null && position.id !== null
                ? sql`and p.available_at >= ${position.at}::timestamptz
                    and (p.available_at > ${position.at}::timestamptz or p.id > ${position.id})`
                : sql``
            }
          order by p.available_at, p.id
          limit ${input.limit}`)),
      ];
      if (scanned.length > 0) break;
      const next = CRAWL_PAGE_STATUSES[CRAWL_PAGE_STATUSES.indexOf(position.status) + 1];
      if (!next) return { cursor: null, scanned: 0, rows: {}, kept: {}, codesDeleted: 0 };
      position = { status: next, at: null, id: null };
    }
    const last = scanned[scanned.length - 1];
    const cursor = `${position.status}|${last.at}|${last.id}`;

    const { eligible, origin } = crawlEligibility('p', 'j', cutoff);
    const pages = await tx.execute<{
      id: string;
      jobId: string;
      eligible: boolean;
      origin: boolean;
      attempts: number;
    }>(sql`
      select p.id, p.job_id as "jobId", ${eligible} as eligible,
        (${eligible} and ${origin}) as origin,
        (select count(*) from clarity_fetch_attempts a where a.crawl_page_id = p.id)::int as attempts
      from clarity_crawl_pages p join clarity_crawl_jobs j on j.id = p.job_id
      where p.id = any(${ids(scanned.map((row) => row.id))})
      ${input.execute ? sql`for update of p skip locked` : sql``}`);

    const doomed = pages.filter((page) => page.eligible && !page.origin);
    const origins = pages.filter((page) => page.origin);
    const touchedJobs = [...new Set(doomed.map((page) => page.jobId))];
    const rows: Record<string, number> = {
      clarity_crawl_pages: doomed.length,
      clarity_fetch_attempts: [...doomed, ...origins].reduce((sum, page) => sum + page.attempts, 0),
    };
    const kept = {
      crawl_pages_recrawl_origin: origins.length,
      crawl_pages_operation_open_or_recent: pages.filter((page) => !page.eligible).length,
    };

    if (input.execute) {
      if (doomed.length > 0)
        await tx.execute(
          sql`delete from clarity_crawl_pages where id = any(${ids(doomed.map((page) => page.id))})`,
        );
      if (origins.length > 0)
        await tx.execute(
          sql`delete from clarity_fetch_attempts where crawl_page_id = any(${ids(origins.map((page) => page.id))})`,
        );
      const [gone] =
        touchedJobs.length === 0
          ? [{ jobs: 0 }]
          : await tx.execute<{ jobs: number }>(sql`
            with gone as (
              delete from clarity_crawl_jobs j
              where j.id = any(${ids(touchedJobs)})
                and j.status = any(${ids(TERMINAL_CRAWL_OPERATIONS)})
                and j.kind <> 'removal'
                and coalesce(j.finished_at, j.updated_at) < ${cutoff}::timestamptz
                and not exists (select 1 from clarity_crawl_pages p where p.job_id = j.id)
              returning 1)
            select count(*)::int as jobs from gone`);
      rows.clarity_crawl_jobs = Number(gone?.jobs ?? 0);
    } else {
      // An operation goes once every page of it would: counted once per run.
      const fresh = touchedJobs.filter((id) => !input.countedJobs.has(id));
      const q = crawlEligibility('q', 'j', cutoff);
      const emptied =
        fresh.length === 0
          ? []
          : await tx.execute<{ id: string }>(sql`
            select j.id from clarity_crawl_jobs j
            where j.id = any(${ids(fresh)})
              and not exists (
                select 1 from clarity_crawl_pages q
                where q.job_id = j.id and not (${q.eligible} and not ${q.origin}))`);
      for (const { id } of emptied) input.countedJobs.add(id);
      rows.clarity_crawl_jobs = emptied.length;
    }
    return { cursor, scanned: scanned.length, rows, kept, codesDeleted: 0 };
  });
}

// ---------------------------------------------------------------------------
// The run

/** What to run after a purge that removed codes from the semantic index. */
export function hnswAdvice(codesDeleted: number): string[] {
  if (codesDeleted === 0) return [];
  return [
    `-- ${codesDeleted} codes left deleted elements in ${CODES_HNSW_INDEX}.`,
    '-- Rebuild it before VACUUM repairs the graph element by element (pgvector README):',
    "SET maintenance_work_mem = '2GB'; SET statement_timeout = 0;",
    `REINDEX INDEX CONCURRENTLY ${CODES_HNSW_INDEX};`,
    'VACUUM (ANALYZE) clarity_search_chunk_embeddings;',
  ];
}

export async function runRetention(
  db: ClarityExecutor,
  options: RetentionOptions,
): Promise<RetentionReport> {
  if (!RETENTION_TARGETS.includes(options.target))
    throw new Error(`Unknown retention target: ${options.target}`);
  if (!Number.isFinite(options.retentionDays) || options.retentionDays < MIN_RETENTION_DAYS)
    throw new Error(`The retention window must be at least ${MIN_RETENTION_DAYS} days`);
  const execute = options.execute === true;
  const clock = options.clock ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const cutoff = cutoffOf(options.now ?? new Date(), options.retentionDays);
  const allowed = options.includeStale
    ? [...DEAD_LISTING_STATUSES, 'stale']
    : [...DEAD_LISTING_STATUSES];
  const withBacklog = options.target !== 'crawl' && (await hasChunkColumn(db, CHUNK_BACKLOG_TABLE));
  const tables =
    options.target === 'crawl'
      ? CRAWL_TABLES
      : [...JOB_DOCUMENT_TABLES, ...(withBacklog ? [CHUNK_BACKLOG_TABLE] : [])];
  const rowBytes = await averageRowBytes(db, tables);

  const report: RetentionReport = {
    target: options.target,
    execute,
    cutoff: cutoff.toISOString(),
    batches: 0,
    cursor: options.after ?? null,
    complete: false,
    rows: {},
    kept: {},
    estimatedBytes: {},
    totalEstimatedBytes: 0,
    codesDeleted: 0,
  };
  options.log('start', {
    target: options.target,
    execute,
    cutoff: report.cutoff,
    retentionDays: options.retentionDays,
    includeStale: Boolean(options.includeStale),
    after: report.cursor,
    rowBytes,
  });

  const wait = msUntilWindow(options.window, clock());
  if (wait > 0) {
    options.log('waiting_for_window', { ms: wait, window: options.window });
    await sleep(wait);
  }

  const pacer = new BatchPacer(options.pacing);
  const countedJobs = new Set<string>();
  for (;;) {
    if (!insideWindow(options.window, clock())) {
      report.stoppedBy = 'window';
      break;
    }
    if (options.maxBatches !== undefined && report.batches >= options.maxBatches) {
      report.stoppedBy = 'max-batches';
      break;
    }
    const started = Date.now();
    const batch =
      options.target === 'crawl'
        ? await crawlBatch(db, {
            execute,
            cutoff,
            after: report.cursor,
            limit: pacer.batchSize,
            countedJobs,
          })
        : await jobBatch(db, {
            target: options.target,
            execute,
            cutoff,
            after: report.cursor,
            limit: pacer.batchSize,
            allowed,
            withBacklog,
          });
    const took = Date.now() - started;
    report.batches += 1;
    add(report.rows, batch.rows);
    add(report.kept, batch.kept);
    report.codesDeleted += batch.codesDeleted;
    // A short job batch is the end of the walk; a short crawl batch is the end
    // of one page status, and the next batch moves on to the next status.
    const exhausted =
      batch.cursor === null || (options.target !== 'crawl' && batch.scanned < pacer.batchSize);
    report.cursor = exhausted ? null : batch.cursor;
    if (exhausted) {
      report.complete = true;
      break;
    }
    const pace = pacer.next(took);
    if (pace.slowed) options.log('slow_batch', { took, nextBatchSize: pace.batchSize });
    if (report.batches % 20 === 0)
      options.log('progress', {
        batches: report.batches,
        cursor: report.cursor,
        rows: report.rows,
        kept: report.kept,
      });
    if (pace.restMs > 0) await sleep(pace.restMs);
  }

  for (const [table, count] of Object.entries(report.rows)) {
    const bytes = Math.round(count * (rowBytes[table] ?? 0));
    report.estimatedBytes[table] = bytes;
    report.totalEstimatedBytes += bytes;
  }
  options.log('done', {
    ...report,
    totalEstimatedGiB: Math.round((report.totalEstimatedBytes / 2 ** 30) * 100) / 100,
  });
  if (execute && options.target === 'job-documents')
    for (const line of hnswAdvice(report.codesDeleted)) options.log('hnsw_advice', { sql: line });
  return report;
}
