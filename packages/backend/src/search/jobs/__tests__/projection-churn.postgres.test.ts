import { eq, inArray, sql, TransactionRollbackError } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../../db/index.js';
import {
  jobClusters,
  jobPostingSignatures,
  jobPostings,
  searchChunkEmbeddings,
  searchChunks,
  searchDocuments,
} from '../../../db/schema/index.js';
import { createEmbeddings, embeddingsEnabled } from '../../../lib/kaana-embeddings.js';
import { flushChunkEmbeddingsForTests, queueEmbeddingBacklog } from '../../chunking.js';
import { extractJobPostings } from '../extract.js';
import { staleJobPredicate, sweepJobLifecycle } from '../lifecycle.js';
import {
  closeJobPostingsForDocument,
  ingestJobPosting,
  JOB_SIGHTING_REFRESH_MS,
  projectJobPostings,
  recordJobSighting,
} from '../projection.js';

/**
 * A feed re-delivers every live listing on every poll, so re-observing an
 * unchanged listing is the hot path of the whole Jobs corpus. It used to
 * rewrite the listing's ~10 KB row and its TOAST, its signatures, its cluster
 * and every chunk of its document; these tests pin what it writes now.
 */
vi.mock('../../../lib/kaana-embeddings.js', () => ({
  CLARITY_EMBEDDING_MODEL: 'test-embedding-model',
  embeddingsEnabled: vi.fn(() => true),
  createEmbeddings: vi.fn(),
}));

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const now = Date.now();
const at = (minutes: number) => new Date(now + minutes * 60_000);
const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000);

const employerUrl = 'https://churn-employer.example/careers/platform-engineer';
const boardUrl = 'https://boards.greenhouse.io/churn-employer/jobs/7781';
const loneUrl = 'https://churn-employer.example/careers/lone-role';
const batchUrls = Array.from(
  { length: 10 },
  (_, index) => `https://batch-employer-${index}.example/careers/role-${index}`,
);
const urls = [employerUrl, boardUrl, loneUrl, ...batchUrls];

/** Words that do not compress away, so the description is stored out of line in TOAST. */
function incompressibleText(seed: number, words: number): string {
  let state = seed;
  const output: string[] = [];
  for (let index = 0; index < words; index += 1) {
    let word = '';
    for (let letter = 0; letter < 7; letter += 1) {
      state = (state * 48_271) % 2_147_483_647;
      word += String.fromCharCode(97 + (state % 26));
    }
    output.push(word);
  }
  return output.join(' ');
}

/**
 * The employer's page and the board carry one opening and group into one
 * cluster; the lone role shares no signature with either.
 */
function listing(url: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const lone = url === loneUrl;
  return {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: lone ? 'Site Reliability Engineer' : 'Platform Engineer',
    description: incompressibleText(lone ? 3 : 7, 1_500),
    identifier: {
      '@type': 'PropertyValue',
      name: 'Greenhouse',
      value: lone ? 'CHURN-1001' : 'CHURN-7781',
    },
    datePosted: daysAgo(2).toISOString(),
    employmentType: 'FULL_TIME',
    jobLocation: { address: { addressLocality: 'Lisbon', addressCountry: 'PT' } },
    hiringOrganization: {
      '@type': 'Organization',
      name: 'Churn Employer',
      url: 'https://churn-employer.example',
    },
    url,
    ...overrides,
  };
}

function ingest(url: string, observedAt: Date, overrides: Record<string, unknown> = {}) {
  return ingestJobPosting({
    canonicalUrl: url,
    structuredData: [listing(url, overrides)],
    siteId: null,
    sourceType: 'feed',
    fieldSource: 'feed',
    observedAt,
  });
}

interface Snapshot {
  posting: {
    id: string;
    xmin: string;
    descriptionToast: string | null;
    lastSeenAt: Date;
    status: string;
    closedAt: Date | null;
    clusterId: string | null;
    titleExtractedAt: string;
  };
  documentToast: string | null;
  documentXmin: string;
  signatures: string[];
  chunkIds: string[];
  embeddedChunks: number;
}

async function snapshot(url: string): Promise<Snapshot> {
  const [posting] = await getDb()
    .select({
      id: jobPostings.id,
      xmin: sql<string>`${jobPostings}.xmin::text`,
      descriptionToast: sql<
        string | null
      >`pg_column_toast_chunk_id(${jobPostings.description})::text`,
      lastSeenAt: jobPostings.lastSeenAt,
      status: jobPostings.status,
      closedAt: jobPostings.closedAt,
      clusterId: jobPostings.clusterId,
      titleExtractedAt: sql<string>`${jobPostings.fieldEvidence} -> 'title' ->> 'extractedAt'`,
    })
    .from(jobPostings)
    .where(eq(jobPostings.canonicalUrl, url));
  const [document] = await getDb()
    .select({
      id: searchDocuments.id,
      toast: sql<string | null>`pg_column_toast_chunk_id(${searchDocuments.structuredData})::text`,
      xmin: sql<string>`${searchDocuments}.xmin::text`,
    })
    .from(searchDocuments)
    .where(eq(searchDocuments.canonicalUrl, url));
  // xmin and ctid change whenever a row is rewritten, even to the same values.
  const signatures = await getDb()
    .select({
      version: sql<string>`${jobPostingSignatures}.xmin::text || ${jobPostingSignatures}.ctid::text`,
    })
    .from(jobPostingSignatures)
    .where(eq(jobPostingSignatures.jobPostingId, posting.id));
  const chunks = await getDb()
    .select({
      id: searchChunks.id,
      embedded: sql<boolean>`${searchChunkEmbeddings.code} is not null`,
    })
    .from(searchChunks)
    .leftJoin(searchChunkEmbeddings, eq(searchChunkEmbeddings.chunkId, searchChunks.id))
    .where(eq(searchChunks.documentId, document.id))
    .orderBy(searchChunks.position);
  return {
    posting,
    documentToast: document.toast,
    documentXmin: document.xmin,
    signatures: signatures.map((row) => row.version).sort(),
    chunkIds: chunks.map((row) => row.id),
    embeddedChunks: chunks.filter((row) => row.embedded).length,
  };
}

const tables = {
  postings: sql`'clarity_job_postings'::regclass`,
  postingsToast: sql`(select reltoastrelid from pg_class where oid = 'clarity_job_postings'::regclass)`,
  signatures: sql`'clarity_job_posting_signatures'::regclass`,
  clusters: sql`'clarity_job_clusters'::regclass`,
};

type Executor = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

/**
 * Tuples this backend has inserted, updated or deleted per table and not yet
 * reported. Only a difference taken inside one transaction is meaningful: the
 * pending counters also hold earlier transactions on the same connection.
 */
async function writeCounters(tx: Executor) {
  const counts: Record<string, number> = {};
  for (const [name, table] of Object.entries(tables)) {
    const [row] = await tx.execute<{ written: number }>(sql`
      select (pg_stat_get_xact_tuples_inserted(${table})
        + pg_stat_get_xact_tuples_updated(${table})
        + pg_stat_get_xact_tuples_deleted(${table}))::int as written`);
    counts[name] = row.written;
  }
  return counts;
}

/**
 * Projects the fixture listing at `url` straight into its document and
 * returns how many tuples that wrote, per table.
 */
async function projectCounted(
  url: string,
  observedAt: Date,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, number>> {
  const [document] = await getDb()
    .select({ id: searchDocuments.id })
    .from(searchDocuments)
    .where(eq(searchDocuments.canonicalUrl, url));
  return getDb().transaction(async (tx) => {
    const before = await writeCounters(tx);
    await projectJobPostings(tx, {
      documentId: document.id,
      documentStatus: 'indexed',
      postings: extractJobPostings(
        [listing(url, overrides)],
        url,
        observedAt.toISOString(),
        'feed',
      ),
      sourceType: 'feed',
      observedAt,
    });
    const after = await writeCounters(tx);
    return Object.fromEntries(
      Object.entries(after).map(([name, count]) => [name, count - before[name]]),
    );
  });
}

suite('re-observing job listings on Postgres', () => {
  const removeFixtures = () =>
    getDb().delete(searchDocuments).where(inArray(searchDocuments.canonicalUrl, urls));

  beforeAll(async () => {
    connectPostgres(databaseUrl);
    await removeFixtures();
  });

  afterAll(async () => {
    await removeFixtures();
    await getDb()
      .delete(jobClusters)
      .where(
        sql`not exists (select 1 from ${jobPostings} where ${jobPostings.clusterId} = ${jobClusters.id})`,
      );
    await closePostgres();
  });

  beforeEach(() => {
    // An embedding route that fails on every call is the case that churned
    // the chunks table.
    vi.mocked(embeddingsEnabled).mockReturnValue(true);
    vi.mocked(createEmbeddings).mockRejectedValue(new Error('embedding route unavailable'));
  });

  it('records only the sighting when an unchanged listing is delivered again', async () => {
    await ingest(loneUrl, at(0));
    const before = await snapshot(loneUrl);
    expect(before.posting.descriptionToast).not.toBeNull();
    // A job document keeps no JSON-LD: the listing is its projection, and a
    // listing listed again is sighted (`recordJobSighting`), never re-read.
    expect(before.documentToast).toBeNull();
    expect(before.chunkIds.length).toBeGreaterThan(1);

    // Within a day of its last sighting, the same listing writes nothing —
    // unless its chunks are still owed embeddings (they are here: Kaana is a
    // bare mock), which a full ingest queues again.
    vi.mocked(embeddingsEnabled).mockReturnValue(false);
    await ingest(loneUrl, at(60));
    vi.mocked(embeddingsEnabled).mockReturnValue(true);
    const unwritten = await snapshot(loneUrl);
    expect(unwritten.posting.xmin).toBe(before.posting.xmin);
    expect(unwritten.documentXmin).toBe(before.documentXmin);
    expect(unwritten.posting.lastSeenAt).toEqual(at(0));

    const nextDay = at(JOB_SIGHTING_REFRESH_MS / 60_000 + 1);
    await ingest(loneUrl, nextDay);
    const after = await snapshot(loneUrl);

    expect(after.posting.lastSeenAt).toEqual(nextDay);
    expect(after.posting.status).toBe('active');
    // The row itself is written once, for the sighting...
    expect(after.posting.xmin).not.toBe(before.posting.xmin);
    // ...but its TOASTed content, signatures and chunks are left in place.
    expect(after.posting.descriptionToast).toBe(before.posting.descriptionToast);
    expect(after.documentToast).toBe(before.documentToast);
    expect(after.signatures).toEqual(before.signatures);
    expect(after.chunkIds).toEqual(before.chunkIds);
    // Evidence still says when the stored value was extracted.
    expect(after.posting.titleExtractedAt).toBe(at(0).toISOString());
  });

  it('writes nothing for an unchanged listing seen within a day, one row after it, and only the difference for a changed one', async () => {
    // Sighted at `nextDay` by the test above: an hour later nothing changes.
    const sighted = at(JOB_SIGHTING_REFRESH_MS / 60_000 + 1);
    expect(await projectCounted(loneUrl, new Date(sighted.getTime() + 3_600_000))).toEqual({
      postings: 0,
      postingsToast: 0,
      signatures: 0,
      clusters: 0,
    });
    expect(
      await projectCounted(loneUrl, new Date(sighted.getTime() + JOB_SIGHTING_REFRESH_MS + 60_000)),
    ).toEqual({
      postings: 1,
      postingsToast: 0,
      signatures: 0,
      clusters: 0,
    });

    // A new salary changes the row but none of its grouping signatures, and
    // the listing is in no cluster: nothing beyond the row is written.
    const salaried = await projectCounted(loneUrl, at(180), {
      baseSalary: {
        '@type': 'MonetaryAmount',
        currency: 'EUR',
        value: { '@type': 'QuantitativeValue', minValue: 60000, maxValue: 80000, unitText: 'YEAR' },
      },
    });
    expect(salaried).toMatchObject({ postings: 1, signatures: 0, clusters: 0 });
  });

  it('rewrites a listing whose content changed', async () => {
    const before = await snapshot(loneUrl);
    await ingest(loneUrl, at(240), { description: incompressibleText(11, 1_500) });
    const after = await snapshot(loneUrl);

    expect(after.posting.descriptionToast).not.toBe(before.posting.descriptionToast);
    expect(after.posting.titleExtractedAt).toBe(at(240).toISOString());
    // The content signature follows the description; the others stay.
    expect(after.signatures).not.toEqual(before.signatures);
    expect(after.chunkIds).not.toEqual(before.chunkIds);
  });

  it('writes a listing stored before fingerprints in full once, then only its sightings', async () => {
    await getDb()
      .update(jobPostings)
      .set({ contentHash: null })
      .where(eq(jobPostings.canonicalUrl, loneUrl));
    const legacy = await snapshot(loneUrl);

    await ingest(loneUrl, at(300), { description: incompressibleText(11, 1_500) });
    const backfilled = await snapshot(loneUrl);
    expect(backfilled.posting.descriptionToast).not.toBe(legacy.posting.descriptionToast);

    await ingest(loneUrl, at(360), { description: incompressibleText(11, 1_500) });
    expect((await snapshot(loneUrl)).posting.descriptionToast).toBe(
      backfilled.posting.descriptionToast,
    );
  });

  it('embeds chunks stored without embeddings once the embedding capability appears, through the backlog sweep', async () => {
    // What earlier tests queued is sent (and refused) now, not in the middle of this one.
    await flushChunkEmbeddingsForTests();
    const lexical = await snapshot(loneUrl);
    expect(lexical.embeddedChunks).toBe(0);
    const content = { description: incompressibleText(11, 1_500) };

    // No capability: the route is never called and the unembedded chunks stay.
    vi.mocked(embeddingsEnabled).mockReturnValue(false);
    vi.mocked(createEmbeddings).mockClear();
    await ingest(loneUrl, at(400), content);
    expect(createEmbeddings).not.toHaveBeenCalled();
    expect((await snapshot(loneUrl)).chunkIds).toEqual(lexical.chunkIds);

    vi.mocked(embeddingsEnabled).mockReturnValue(true);
    vi.mocked(createEmbeddings).mockImplementation(async (texts: readonly string[]) =>
      texts.map(() => Array.from({ length: 1024 }, () => 0.1)),
    );
    await ingest(loneUrl, at(420), content);
    // Delivered again unchanged within a day, the listing writes nothing and
    // queues nothing: the vectors it owes are the backlog sweep's.
    await flushChunkEmbeddingsForTests();
    expect(createEmbeddings).not.toHaveBeenCalled();
    for (let sweeps = 0; sweeps < 20; sweeps += 1) {
      await queueEmbeddingBacklog();
      await flushChunkEmbeddingsForTests();
      const owed = await snapshot(loneUrl);
      if (owed.embeddedChunks === owed.chunkIds.length) break;
    }
    expect(createEmbeddings).toHaveBeenCalled();
    const embedded = await snapshot(loneUrl);
    expect(embedded.embeddedChunks).toBe(embedded.chunkIds.length);
    // The vectors are written into the chunks already stored, not by replacing them.
    expect(embedded.chunkIds).toEqual(lexical.chunkIds);

    await ingest(loneUrl, at(480), content);
    expect((await snapshot(loneUrl)).chunkIds).toEqual(embedded.chunkIds);
  });

  it('reopens a closed copy on its next sighting and shows it for its cluster again', async () => {
    await ingest(employerUrl, at(0));
    await ingest(boardUrl, at(0));
    const employer = await snapshot(employerUrl);
    expect(employer.posting.clusterId).not.toBeNull();
    expect((await snapshot(boardUrl)).posting.clusterId).toBe(employer.posting.clusterId);
    const canonical = async () => {
      const [cluster] = await getDb()
        .select({ id: jobClusters.canonicalJobPostingId })
        .from(jobClusters)
        .where(eq(jobClusters.id, employer.posting.clusterId ?? ''));
      return cluster.id;
    };
    expect(await canonical()).toBe(employer.posting.id);
    // A grouped copy seen again within a day writes nothing: not its row, its
    // cluster, nor the signatures that grouped it.
    expect(await projectCounted(employerUrl, at(30))).toEqual({
      postings: 0,
      postingsToast: 0,
      signatures: 0,
      clusters: 0,
    });

    const [document] = await getDb()
      .select({ id: searchDocuments.id })
      .from(searchDocuments)
      .where(eq(searchDocuments.canonicalUrl, employerUrl));
    await closeJobPostingsForDocument(getDb(), document.id, 'posting_absent');
    expect(await canonical()).not.toBe(employer.posting.id);

    await ingest(employerUrl, at(60));
    const reopened = await snapshot(employerUrl);
    expect(reopened.posting).toMatchObject({ status: 'active', closedAt: null });
    expect(reopened.posting.descriptionToast).toBe(employer.posting.descriptionToast);
    expect(await canonical()).toBe(employer.posting.id);
  });

  it('ages listings out on their own window through an index', async () => {
    const [document] = await getDb()
      .select({ id: searchDocuments.id })
      .from(searchDocuments)
      .where(eq(searchDocuments.canonicalUrl, boardUrl));
    const lastSeen = async (sourceType: 'feed' | 'web', days: number) => {
      await getDb()
        .update(jobPostings)
        .set({ sourceType, lastSeenAt: daysAgo(days), status: 'active' })
        .where(eq(jobPostings.documentId, document.id));
      await sweepJobLifecycle();
      const [row] = await getDb()
        .select({ status: jobPostings.status })
        .from(jobPostings)
        .where(eq(jobPostings.documentId, document.id));
      return row.status;
    };
    expect(await lastSeen('feed', 13)).toBe('active');
    expect(await lastSeen('feed', 15)).toBe('stale');
    expect(await lastSeen('web', 15)).toBe('active');
    expect(await lastSeen('web', 46)).toBe('stale');

    // A per-row interval made this a sequential scan of the whole table every
    // 15 minutes. Production's shape — thousands of listings, nearly all of
    // them active and seen within hours — is built and analysed inside a
    // transaction that is rolled back, and the plan must bound the scan by
    // last_seen_at instead of reading every active listing.
    let plan = '';
    await getDb()
      .transaction(async (tx) => {
        await tx.execute(sql`
          insert into ${jobPostings} (id, document_id, source_key, canonical_url, title,
            normalized_title, employer_name, source_type, source_domain, search_vector, last_seen_at)
          select gen_random_uuid()::text, ${document.id}, 'plan-' || n, ${boardUrl} || '#' || n,
            'Plan', 'plan', 'Plan', 'feed', 'plan.example', ''::tsvector,
            now() - (n % 48) * interval '1 hour'
          from generate_series(1, 5000) as n`);
        await tx.execute(sql`analyze ${jobPostings}`);
        await tx.execute(sql`set local enable_seqscan = off`);
        const explained = await tx.execute<{ 'QUERY PLAN': string }>(
          sql`explain ${tx.select({ id: jobPostings.id }).from(jobPostings).where(staleJobPredicate())}`,
        );
        plan = explained.map((row) => row['QUERY PLAN']).join('\n');
        tx.rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });
    expect(plan).not.toContain('Seq Scan');
    expect(plan).toContain('clarity_job_postings_status_last_seen_idx');
    expect(plan).toMatch(/Index Cond: .*last_seen_at/);
  });

  it('embeds the chunks of many listings in one request', async () => {
    await flushChunkEmbeddingsForTests();
    vi.mocked(createEmbeddings).mockReset();
    vi.mocked(createEmbeddings).mockImplementation(async (texts: readonly string[]) =>
      texts.map(() => Array.from({ length: 1024 }, () => 0.1)),
    );

    // Ten listings of one feed page, indexed one after another as the poll does.
    for (const [index, url] of batchUrls.entries())
      await ingest(url, at(600), {
        title: `Batch Role ${index}`,
        identifier: { '@type': 'PropertyValue', name: 'Batch', value: `BATCH-${index}` },
        description: incompressibleText(100 + index, 700),
        hiringOrganization: { '@type': 'Organization', name: `Batch Employer ${index}` },
      });
    expect(createEmbeddings).not.toHaveBeenCalled();
    await flushChunkEmbeddingsForTests();

    // One request for every listing's chunks, where there was one per listing.
    const snapshots = await Promise.all(batchUrls.map(snapshot));
    const chunks = snapshots.reduce((total, listed) => total + listed.chunkIds.length, 0);
    expect(chunks).toBeGreaterThan(batchUrls.length);
    expect(createEmbeddings).toHaveBeenCalledOnce();
    expect(vi.mocked(createEmbeddings).mock.calls[0][0]).toHaveLength(chunks);
    for (const listed of snapshots) expect(listed.embeddedChunks).toBe(listed.chunkIds.length);
  });

  it('sights a listing its feed lists again exactly as re-ingesting its payload did', async () => {
    const sightingUrl = batchUrls[9];
    const ingested = await ingest(sightingUrl, at(0));
    const [document] = await getDb()
      .select({ structuredData: searchDocuments.structuredData })
      .from(searchDocuments)
      .where(eq(searchDocuments.id, ingested.documentId));
    expect(document.structuredData).toEqual([]);

    // Gone yesterday, listed again today: the sighting reopens it, as a
    // re-ingest of its unchanged payload did.
    await getDb().transaction((tx) =>
      closeJobPostingsForDocument(tx, ingested.documentId, 'http_gone'),
    );
    const nextDay = new Date(at(0).getTime() + JOB_SIGHTING_REFRESH_MS + 60_000);
    const sighted = await recordJobSighting({
      canonicalUrl: sightingUrl,
      sourceType: 'feed',
      observedAt: nextDay,
    });
    expect(sighted?.jobPostingIds).toEqual(ingested.jobPostingIds);
    const [posting] = await getDb()
      .select({
        status: jobPostings.status,
        closedAt: jobPostings.closedAt,
        closureReason: jobPostings.closureReason,
        lastSeenAt: jobPostings.lastSeenAt,
      })
      .from(jobPostings)
      .where(eq(jobPostings.id, ingested.jobPostingIds[0]));
    expect(posting).toMatchObject({ status: 'active', closedAt: null, closureReason: null });
    expect(posting.lastSeenAt.getTime()).toBe(nextDay.getTime());

    // Seen again within the refresh window: nothing is written.
    const [{ xmin }] = await getDb()
      .select({ xmin: sql<string>`${jobPostings}.xmin::text` })
      .from(jobPostings)
      .where(eq(jobPostings.id, ingested.jobPostingIds[0]));
    vi.mocked(embeddingsEnabled).mockReturnValue(false);
    await recordJobSighting({
      canonicalUrl: sightingUrl,
      sourceType: 'feed',
      observedAt: new Date(nextDay.getTime() + 60_000),
    });
    vi.mocked(embeddingsEnabled).mockReturnValue(true);
    const [again] = await getDb()
      .select({ xmin: sql<string>`${jobPostings}.xmin::text` })
      .from(jobPostings)
      .where(eq(jobPostings.id, ingested.jobPostingIds[0]));
    expect(again.xmin).toBe(xmin);
  });

  it('never reopens a listing its last payload withdrew, and sights nothing it does not hold', async () => {
    const withdrawnUrl = batchUrls[8];
    const ingested = await ingest(withdrawnUrl, at(0));
    await getDb().transaction((tx) =>
      closeJobPostingsForDocument(tx, ingested.documentId, 'posting_absent'),
    );
    expect(
      await recordJobSighting({
        canonicalUrl: withdrawnUrl,
        sourceType: 'feed',
        observedAt: at(2_000),
      }),
    ).toBeUndefined();
    const [posting] = await getDb()
      .select({ status: jobPostings.status })
      .from(jobPostings)
      .where(eq(jobPostings.id, ingested.jobPostingIds[0]));
    expect(posting.status).toBe('closed');
    expect(
      await recordJobSighting({
        canonicalUrl: 'https://never-indexed.example/careers/role',
        sourceType: 'feed',
        observedAt: at(2_000),
      }),
    ).toBeUndefined();
  });
});
