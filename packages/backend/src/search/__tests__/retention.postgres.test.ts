import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { type RetentionOptions, runRetention } from '../retention.js';

/**
 * Retention (search/retention.ts) on Postgres: what each target selects and
 * keeps, that a dry run writes nothing, and that a run stopped part way
 * resumes from its cursor and is idempotent.
 *
 * The shared CI database holds other suites' rows, all dated around the real
 * now. Every fixture here is dated around a clock 25 years earlier and the
 * job runs on that clock, so its cutoff (30 days before it) can only reach
 * these fixtures.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
// The job deletes across the whole database: only a disposable CI one
// (`clarity_ci`, or a `clarity_ci_*` copy of it).
if (databaseUrl && !/^\/clarity_ci(_[a-z0-9_]+)?$/.test(new URL(databaseUrl).pathname))
  throw new Error('Use only a disposable clarity_ci database');
const suite = databaseUrl ? describe : describe.skip;

const NOW = new Date('2001-01-01T00:00:00Z');
const OLD = '2000-06-01T00:00:00Z';
const OLDER = '2000-05-01T00:00:00Z';
const RECENT = '2000-12-20T00:00:00Z';
const run = crypto.randomUUID().slice(0, 8);
const url = (name: string) => `https://retention-${run}.example/${name}`;

const docIds: Record<string, string> = {};
const postingIds: Record<string, string> = {};
const jobIds: Record<string, string> = {};
const pageIds: Record<string, string> = {};
const clusterId = crypto.randomUUID();

const options = (overrides: Partial<RetentionOptions>): RetentionOptions => ({
  target: 'job-documents',
  retentionDays: 30,
  now: NOW,
  window: null,
  pacing: { batchSize: 100, minBatchSize: 1, maxBatchMs: 60_000, pauseMs: 0, dutyCycle: 1 },
  log: () => undefined,
  sleep: async () => undefined,
  ...overrides,
});

async function document(
  name: string,
  input: { clock: string; type?: string; postings?: { status: string; lastSeen: string }[] },
): Promise<void> {
  const id = crypto.randomUUID();
  docIds[name] = id;
  await getDb().execute(sql`
    insert into clarity_search_documents
      (id, requested_url, canonical_url, status, document_type, title, fetched_at, updated_at, created_at)
    values (${id}, ${url(name)}, ${url(name)}, 'indexed', ${input.type ?? 'job'}, ${name},
      ${input.clock}::timestamptz, ${input.clock}::timestamptz, ${input.clock}::timestamptz)`);
  for (const position of [0, 1]) {
    const chunk = crypto.randomUUID();
    await getDb().execute(sql`
      insert into clarity_search_chunks (id, document_id, position, start_offset, end_offset, text, extractor_version)
      values (${chunk}, ${id}, ${position}, ${position * 1600}, ${position * 1600 + 10}, ${`${name} chunk ${position}`}, 'test')`);
    await getDb().execute(sql`
      insert into clarity_search_chunk_embeddings (chunk_id, document_id, code, model)
      values (${chunk}, ${id},
        binary_quantize(array_fill(0.1::real, array[1024])::halfvec(1024))::bit(1024), 'test-model')`);
    await getDb().execute(sql`
      insert into clarity_search_chunk_vectors (chunk_id, embedding)
      values (${chunk}, array_fill(0.1::real, array[1024])::halfvec(1024))`);
  }
  for (const [index, posting] of (input.postings ?? []).entries()) {
    const postingId = crypto.randomUUID();
    postingIds[`${name}#${index}`] = postingId;
    await getDb().execute(sql`
      insert into clarity_job_postings
        (id, document_id, source_key, canonical_url, title, normalized_title, employer_name,
         source_domain, status, last_seen_at, first_seen_at, closed_at, cluster_id)
      values (${postingId}, ${id}, ${`key-${index}`}, ${url(name)}, ${name}, ${name}, 'Acme',
        ${`retention-${run}.example`}, ${posting.status}, ${posting.lastSeen}::timestamptz,
        ${OLDER}::timestamptz,
        ${posting.status === 'closed' ? posting.lastSeen : null}::timestamptz,
        ${name === 'closed' || name === 'activeOld' ? clusterId : null})`);
    await getDb().execute(sql`
      insert into clarity_job_posting_signatures (job_posting_id, signature, kind)
      values (${postingId}, ${`sig-${run}-${name}-${index}`}, 'listing_url')`);
  }
}

async function crawlJob(
  name: string,
  input: { status: string; finished: string | null; kind?: string },
): Promise<void> {
  const id = crypto.randomUUID();
  jobIds[name] = id;
  await getDb().execute(sql`
    insert into clarity_crawl_jobs
      (id, owner_account_id, application_id, kind, status, idempotency_key, finished_at, created_at, updated_at)
    values (${id}, ${`retention-${run}`}, 'app', ${input.kind ?? 'urls'}, ${input.status},
      ${`${run}-${name}`}, ${input.finished}::timestamptz, ${OLDER}::timestamptz,
      ${input.finished ?? RECENT}::timestamptz)`);
}

async function crawlPage(
  name: string,
  input: { job: string; url: string; status: string; at: string; attempts: number },
): Promise<void> {
  const id = crypto.randomUUID();
  pageIds[name] = id;
  await getDb().execute(sql`
    insert into clarity_crawl_pages
      (id, job_id, url, discovery_source, status, available_at, created_at, updated_at)
    values (${id}, ${jobIds[input.job]}, ${input.url}, 'seed', ${input.status},
      ${input.at}::timestamptz, ${input.at}::timestamptz, ${input.at}::timestamptz)`);
  for (let attempt = 1; attempt <= input.attempts; attempt += 1)
    await getDb().execute(sql`
      insert into clarity_fetch_attempts (id, crawl_page_id, attempt, fetch_mode, status, started_at, finished_at)
      values (${crypto.randomUUID()}, ${id}, ${attempt}, 'http', 'succeeded',
        ${input.at}::timestamptz, ${input.at}::timestamptz)`);
}

async function existing(table: string, column: string, values: string[]): Promise<string[]> {
  const rows = await getDb().execute<{ id: string }>(
    sql`select ${sql.identifier(column)} as id from ${sql.identifier(table)}
      where ${sql.identifier(column)} = any(${sql.param(values)}::text[])`,
  );
  return rows.map((row) => row.id);
}

const named = (ids: Record<string, string>, present: string[]) =>
  Object.entries(ids)
    .filter(([, id]) => present.includes(id))
    .map(([name]) => name)
    .sort();

async function vectorCount(name: string): Promise<number> {
  const [row] = await getDb().execute<{ count: number }>(sql`
    select count(*)::int as count from clarity_search_chunks c
    join clarity_search_chunk_vectors v on v.chunk_id = c.id where c.document_id = ${docIds[name]}`);
  return Number(row?.count);
}

async function codeCount(name: string): Promise<number> {
  const [row] = await getDb().execute<{ count: number }>(sql`
    select count(*)::int as count from clarity_search_chunk_embeddings where document_id = ${docIds[name]}`);
  return Number(row?.count);
}

suite('search retention (PostgreSQL)', () => {
  beforeAll(async () => {
    connectPostgres(databaseUrl);
    await getDb().execute(
      sql`insert into clarity_job_clusters (id, member_count) values (${clusterId}, 2)`,
    );
    // Dead by default: every listing closed or expired, none seen in 30 days.
    await document('closed', { clock: OLDER, postings: [{ status: 'closed', lastSeen: OLDER }] });
    await document('expired', { clock: OLD, postings: [{ status: 'expired', lastSeen: OLD }] });
    // Dead only with includeStale.
    await document('stale', { clock: OLD, postings: [{ status: 'stale', lastSeen: OLD }] });
    // Kept.
    await document('activeOld', { clock: OLD, postings: [{ status: 'active', lastSeen: OLD }] });
    await document('seenRecently', {
      clock: OLD,
      postings: [{ status: 'closed', lastSeen: RECENT }],
    });
    await document('fetchedRecently', {
      clock: RECENT,
      postings: [{ status: 'closed', lastSeen: OLD }],
    });
    await document('mixed', {
      clock: OLD,
      postings: [
        { status: 'closed', lastSeen: OLD },
        { status: 'active', lastSeen: OLD },
      ],
    });
    await document('page', { clock: OLDER, type: 'page' });

    // Crawl audit.
    await crawlJob('done', { status: 'succeeded', finished: OLD });
    await crawlJob('doneLater', { status: 'partial', finished: OLD });
    await crawlJob('recent', { status: 'succeeded', finished: RECENT });
    await crawlJob('running', { status: 'running', finished: null });
    await crawlJob('cancelled', { status: 'cancelled', finished: OLD });
    await crawlJob('removal', { status: 'succeeded', finished: OLD, kind: 'removal' });
    await crawlPage('plain', {
      job: 'done',
      url: url('plain'),
      status: 'succeeded',
      at: OLDER,
      attempts: 2,
    });
    // A job document's requested URL crawled twice: the older page goes, the
    // newer is its recrawl origin and stays (its attempts go).
    await crawlPage('originOld', {
      job: 'done',
      url: url('activeOld'),
      status: 'succeeded',
      at: OLDER,
      attempts: 1,
    });
    await crawlPage('origin', {
      job: 'doneLater',
      url: url('activeOld'),
      status: 'failed',
      at: OLD,
      attempts: 3,
    });
    await crawlPage('ofRecent', {
      job: 'recent',
      url: url('r1'),
      status: 'succeeded',
      at: OLD,
      attempts: 1,
    });
    await crawlPage('ofRunning', {
      job: 'running',
      url: url('r2'),
      status: 'queued',
      at: OLD,
      attempts: 0,
    });
    await crawlPage('ofCancelled', {
      job: 'cancelled',
      url: url('c1'),
      status: 'queued',
      at: OLD,
      attempts: 1,
    });
    await crawlPage('ofRemoval', {
      job: 'removal',
      url: url('d1'),
      status: 'succeeded',
      at: OLD,
      attempts: 1,
    });
  });

  afterAll(async () => {
    await getDb().execute(
      sql`delete from clarity_search_documents where id = any(${sql.param(Object.values(docIds))}::text[])`,
    );
    await getDb().execute(
      sql`delete from clarity_crawl_jobs where id = any(${sql.param(Object.values(jobIds))}::text[])`,
    );
    await getDb().execute(sql`delete from clarity_job_clusters where id = ${clusterId}`);
    await closePostgres();
  });

  it('dry-runs dead job documents: counts and estimates, and writes nothing', async () => {
    const report = await runRetention(getDb(), options({ target: 'job-documents' }));
    expect(report.execute).toBe(false);
    expect(report.complete).toBe(true);
    expect(report.rows).toMatchObject({
      clarity_search_documents: 2,
      clarity_search_chunks: 4,
      clarity_search_chunk_embeddings: 4,
      clarity_search_chunk_vectors: 4,
      clarity_job_postings: 2,
      clarity_job_posting_signatures: 2,
    });
    expect(report.codesDeleted).toBe(4);
    expect(report.totalEstimatedBytes).toBeGreaterThanOrEqual(0);
    expect(Object.keys(report.estimatedBytes)).toContain('clarity_search_chunk_vectors');
    expect(
      named(docIds, await existing('clarity_search_documents', 'id', Object.values(docIds))),
    ).toHaveLength(8);
  });

  it('counts stale listings as dead only when asked', async () => {
    const report = await runRetention(
      getDb(),
      options({ target: 'job-documents', includeStale: true }),
    );
    expect(report.rows.clarity_search_documents).toBe(3);
  });

  it('refuses a window shorter than a week', async () => {
    await expect(runRetention(getDb(), options({ retentionDays: 3 }))).rejects.toThrow(/7 days/);
  });

  it('waits for the off-peak window and stops when it is closed', async () => {
    const slept: number[] = [];
    const report = await runRetention(
      getDb(),
      options({
        target: 'job-documents',
        execute: true,
        window: { startHour: 1, endHour: 7 },
        clock: () => new Date('2026-11-28T12:00:00Z'),
        sleep: async (ms) => {
          slept.push(ms);
        },
      }),
    );
    expect(slept).toEqual([13 * 3_600_000]);
    expect(report).toMatchObject({ stoppedBy: 'window', batches: 0, complete: false });
    expect(await existing('clarity_search_documents', 'id', [docIds.closed])).toHaveLength(1);
  });

  it('drops only the vectors of dead job documents, once', async () => {
    const report = await runRetention(getDb(), options({ target: 'job-vectors', execute: true }));
    expect(report.rows).toEqual({ clarity_search_chunk_vectors: 4 });
    expect(report.codesDeleted).toBe(0);
    expect(await vectorCount('closed')).toBe(0);
    expect(await vectorCount('expired')).toBe(0);
    // Codes, chunks and documents stay; so does every kept document's vector.
    expect(await codeCount('closed')).toBe(2);
    for (const name of ['stale', 'activeOld', 'seenRecently', 'fetchedRecently', 'mixed', 'page'])
      expect(await vectorCount(name)).toBe(2);

    const again = await runRetention(getDb(), options({ target: 'job-vectors', execute: true }));
    expect(again.rows).toEqual({ clarity_search_chunk_vectors: 0 });
  });

  it('deletes dead job documents in resumable batches, and re-elects their clusters', async () => {
    const first = await runRetention(
      getDb(),
      options({
        target: 'job-documents',
        execute: true,
        maxBatches: 1,
        pacing: { batchSize: 1, minBatchSize: 1, maxBatchMs: 60_000, pauseMs: 0, dutyCycle: 1 },
      }),
    );
    expect(first).toMatchObject({ stoppedBy: 'max-batches', complete: false, batches: 1 });
    expect(first.cursor).toMatch(/\|/);
    // The oldest clock first: `closed`.
    expect(first.rows.clarity_search_documents).toBe(1);
    expect(await existing('clarity_search_documents', 'id', [docIds.closed])).toHaveLength(0);

    const rest = await runRetention(
      getDb(),
      options({
        target: 'job-documents',
        execute: true,
        after: first.cursor,
        pacing: { batchSize: 1, minBatchSize: 1, maxBatchMs: 60_000, pauseMs: 0, dutyCycle: 1 },
      }),
    );
    expect(rest.complete).toBe(true);
    expect(rest.rows.clarity_search_documents).toBe(1);

    const left = named(
      docIds,
      await existing('clarity_search_documents', 'id', Object.values(docIds)),
    );
    expect(left).toEqual(
      ['activeOld', 'fetchedRecently', 'mixed', 'page', 'seenRecently', 'stale'].sort(),
    );
    expect(
      await existing('clarity_job_posting_signatures', 'job_posting_id', [
        postingIds['closed#0'],
        postingIds['expired#0'],
      ]),
    ).toHaveLength(0);
    const [cluster] = await getDb().execute<{ canonical: string; members: number }>(sql`
      select canonical_job_posting_id as canonical, member_count as members
      from clarity_job_clusters where id = ${clusterId}`);
    expect(cluster).toEqual({ canonical: postingIds['activeOld#0'], members: 1 });

    const again = await runRetention(getDb(), options({ target: 'job-documents', execute: true }));
    expect(again.rows.clarity_search_documents ?? 0).toBe(0);
  });

  it('dry-runs the crawl audit without writing', async () => {
    const report = await runRetention(getDb(), options({ target: 'crawl' }));
    expect(report.complete).toBe(true);
    expect(report.rows).toEqual({
      clarity_crawl_pages: 3,
      // plain 2 + originOld 1 + ofCancelled 1, and the origin's own 3.
      clarity_fetch_attempts: 7,
      clarity_crawl_jobs: 2,
    });
    expect(report.kept.crawl_pages_recrawl_origin).toBe(1);
    expect(
      named(pageIds, await existing('clarity_crawl_pages', 'id', Object.values(pageIds))),
    ).toHaveLength(7);
  });

  it('deletes finished crawl audit past the window, keeping recrawl origins and open operations', async () => {
    const report = await runRetention(
      getDb(),
      options({
        target: 'crawl',
        execute: true,
        pacing: { batchSize: 2, minBatchSize: 1, maxBatchMs: 60_000, pauseMs: 0, dutyCycle: 1 },
      }),
    );
    expect(report.complete).toBe(true);
    expect(report.rows).toEqual({
      clarity_crawl_pages: 3,
      clarity_fetch_attempts: 7,
      clarity_crawl_jobs: 2,
    });
    expect(
      named(pageIds, await existing('clarity_crawl_pages', 'id', Object.values(pageIds))),
    ).toEqual(['ofRecent', 'ofRemoval', 'ofRunning', 'origin'].sort());
    expect(
      named(jobIds, await existing('clarity_crawl_jobs', 'id', Object.values(jobIds))),
    ).toEqual(['doneLater', 'recent', 'removal', 'running'].sort());
    expect(
      await existing('clarity_fetch_attempts', 'crawl_page_id', [pageIds.origin]),
    ).toHaveLength(0);
    expect(
      await existing('clarity_fetch_attempts', 'crawl_page_id', [pageIds.ofRecent]),
    ).toHaveLength(1);

    const again = await runRetention(getDb(), options({ target: 'crawl', execute: true }));
    expect(again.rows).toEqual({
      clarity_crawl_pages: 0,
      clarity_fetch_attempts: 0,
      clarity_crawl_jobs: 0,
    });
  });
});
