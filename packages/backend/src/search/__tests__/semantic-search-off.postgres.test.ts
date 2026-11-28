import { inArray } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { jobClusters, jobPostings, searchDocuments } from '../../db/schema/index.js';
import { createEmbeddings } from '../../lib/kaana-embeddings.js';
import { replaceDocumentChunks } from '../chunking.js';
import { searchIndex, searchSchema } from '../document-search.js';
import { extractJobPostings } from '../jobs/extract.js';
import { projectJobPostings } from '../jobs/projection.js';
import { jobSearchSchema, searchJobs } from '../jobs/service.js';

/**
 * `CLARITY_SEMANTIC_SEARCH=off` (semantic-search-switch.ts): web and job
 * searches rank lexically, say so, embed no query and never read the chunks'
 * codes or vectors. Another session holds both tables exclusively while they
 * run, so any read of them would wait out the statement timeout instead.
 */
const embedding = Array.from({ length: 1024 }, (_, index) => ((index % 7) + 1) / 10);

vi.mock('../../lib/kaana-embeddings.js', () => ({
  CLARITY_EMBEDDING_MODEL: 'test-embedding-model',
  embeddingsEnabled: vi.fn(() => true),
  createEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => embedding)),
}));

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
if (databaseUrl && new URL(databaseUrl).pathname !== '/clarity_ci')
  throw new Error('Use only clarity_ci');
const suite = databaseUrl ? describe : describe.skip;

const marker = `semoff${crypto.randomUUID().slice(0, 8)}`;
const documentIds: string[] = [];

async function seedPage() {
  const [document] = await getDb()
    .insert(searchDocuments)
    .values({
      id: crypto.randomUUID(),
      requestedUrl: `https://${marker}.example/page`,
      canonicalUrl: `https://${marker}.example/page`,
      status: 'indexed',
      documentType: 'page',
      title: `Lighthouse keeping ${marker}`,
      indexedAt: new Date(),
    })
    .returning();
  documentIds.push(document.id);
  const text = `Lighthouse keeping ${marker} on a rocky coast.`;
  await replaceDocumentChunks(
    getDb(),
    document.id,
    [{ start: 0, end: text.length, text }],
    [embedding],
    'test-chunker',
  );
}

async function seedJob() {
  const url = `https://${marker}.example/jobs/keeper`;
  const posting = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: `Lighthouse Keeper ${marker}`,
    description: `Keep the ${marker} lighthouse lit through the winter. `.repeat(6),
    datePosted: new Date().toISOString(),
    hiringOrganization: { '@type': 'Organization', name: 'Coastal Trust' },
  };
  const [document] = await getDb()
    .insert(searchDocuments)
    .values({
      id: crypto.randomUUID(),
      requestedUrl: url,
      canonicalUrl: url,
      status: 'indexed',
      documentType: 'job',
      title: posting.title,
      mainContent: posting.description,
      structuredData: [posting],
      indexedAt: new Date(),
    })
    .returning();
  documentIds.push(document.id);
  await projectJobPostings(getDb(), {
    documentId: document.id,
    documentStatus: 'indexed',
    postings: extractJobPostings([posting], url, new Date().toISOString()),
    sourceType: 'web',
    observedAt: new Date(),
  });
}

/** Runs `work` while another session holds the codes and vectors tables exclusively. */
async function withVectorTablesLocked<T>(other: postgres.Sql, work: () => Promise<T>): Promise<T> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked: () => void = () => undefined;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = other.begin(async (session) => {
    await session`lock table clarity_search_chunk_embeddings, clarity_search_chunk_vectors in access exclusive mode`;
    locked();
    await released;
  });
  await isLocked;
  try {
    return await work();
  } finally {
    release();
    await holder;
  }
}

suite('CLARITY_SEMANTIC_SEARCH on Postgres', () => {
  let other: postgres.Sql;

  beforeAll(async () => {
    connectPostgres(databaseUrl);
    other = postgres(databaseUrl, { max: 1 });
    await seedPage();
    await seedJob();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(createEmbeddings).mockClear();
  });

  afterAll(async () => {
    const clusters = await getDb()
      .select({ id: jobPostings.clusterId })
      .from(jobPostings)
      .where(inArray(jobPostings.documentId, documentIds));
    await getDb().delete(searchDocuments).where(inArray(searchDocuments.id, documentIds));
    const clusterIds = clusters.flatMap((row) => (row.id ? [row.id] : []));
    if (clusterIds.length > 0)
      await getDb().delete(jobClusters).where(inArray(jobClusters.id, clusterIds));
    await other.end();
    await closePostgres();
  });

  it('is on by default: a hybrid search embeds its query and is not degraded', async () => {
    const web = await searchIndex(searchSchema.parse({ query: marker, mode: 'hybrid' }));
    expect(web.degraded).toBeUndefined();
    expect(web.data.map((result) => result.title)).toContain(`Lighthouse keeping ${marker}`);
    const jobs = await searchJobs(jobSearchSchema.parse({ query: marker, mode: 'hybrid' }));
    expect(jobs.degraded).toBeUndefined();
    expect(createEmbeddings).toHaveBeenCalled();
  });

  it('off, ranks hybrid searches lexically without reading a code or vector', async () => {
    vi.stubEnv('CLARITY_SEMANTIC_SEARCH', 'off');
    const started = Date.now();
    const { web, jobs } = await withVectorTablesLocked(other, async () => ({
      web: await searchIndex(searchSchema.parse({ query: marker, mode: 'hybrid' })),
      jobs: await searchJobs(jobSearchSchema.parse({ query: marker, mode: 'hybrid' })),
    }));
    // A read of either table would have waited for the lock: the semantic
    // arm's 4 s deadline, then `semantic_timeout`.
    expect(Date.now() - started).toBeLessThan(3_000);
    const degraded = { from: 'hybrid', to: 'lexical', reason: 'semantic_off' };
    expect(web.degraded).toEqual(degraded);
    expect(web.data.map((result) => result.title)).toContain(`Lighthouse keeping ${marker}`);
    expect(jobs.degraded).toEqual(degraded);
    expect(jobs.data.map((job) => job.title)).toContain(`Lighthouse Keeper ${marker}`);
    expect(createEmbeddings).not.toHaveBeenCalled();
  });

  it('off, refuses a semantic search at once', async () => {
    vi.stubEnv('CLARITY_SEMANTIC_SEARCH', 'off');
    await withVectorTablesLocked(other, async () => {
      await expect(
        searchIndex(searchSchema.parse({ query: marker, mode: 'semantic' })),
      ).rejects.toMatchObject({ status: 503, code: 'semantic_unavailable' });
      await expect(
        searchJobs(jobSearchSchema.parse({ query: marker, mode: 'semantic' })),
      ).rejects.toMatchObject({ status: 503, code: 'semantic_unavailable' });
    });
    expect(createEmbeddings).not.toHaveBeenCalled();
  });

  it('off, leaves a lexical search as it was', async () => {
    vi.stubEnv('CLARITY_SEMANTIC_SEARCH', 'off');
    const web = await withVectorTablesLocked(other, () =>
      searchIndex(searchSchema.parse({ query: marker, mode: 'lexical' })),
    );
    expect(web.degraded).toBeUndefined();
    expect(web.data.map((result) => result.title)).toContain(`Lighthouse keeping ${marker}`);
  });
});
