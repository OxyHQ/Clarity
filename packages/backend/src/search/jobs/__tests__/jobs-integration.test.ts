import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../../db/index.js';
import { jobClusters, jobPostings, jobReports, searchDocuments, searchSites } from '../../../db/schema/index.js';
import { replaceDocumentChunks } from '../../chunking.js';
import { extractJobPostings } from '../extract.js';
import { sweepJobLifecycle } from '../lifecycle.js';
import { closeJobPostingsForDocument, ingestJobPosting, projectJobPostings } from '../projection.js';
import { reportJobPosting } from '../reports.js';
import {
  getJobPostingByUrl, jobCorpusStats, jobSearchSchema, searchJobs,
} from '../service.js';
import { createOxyEmbeddings } from '../../../lib/oxy-embeddings.js';

/** A deterministic stand-in so the hybrid SQL runs without the Oxy route. */
const testEmbedding = Array.from({ length: 1024 }, (_, index) => ((index % 7) + 1) / 10);

vi.mock('../../../lib/oxy-embeddings.js', () => ({
  CLARITY_EMBEDDING_MODEL: 'test-embedding-model',
  createOxyEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => testEmbedding)),
}));

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const now = new Date();
const daysAgo = (count: number) => new Date(now.getTime() - count * 24 * 60 * 60 * 1000);
const documentIds: string[] = [];
const firstPartyUrl = 'https://mention.earth/jobs/community-manager';
let firstPartySiteId = '';

interface Seed {
  url: string;
  posting: Record<string, unknown>;
  observedAt?: Date;
  sourceType?: 'web' | 'verified_site' | 'first_party';
}

function jobPosting(fields: Record<string, unknown>): Record<string, unknown> {
  return { '@context': 'https://schema.org', '@type': 'JobPosting', ...fields };
}

async function seed({ url, posting, observedAt = now, sourceType = 'web' }: Seed): Promise<string> {
  const database = getDb();
  const [document] = await database.insert(searchDocuments).values({
    id: crypto.randomUUID(),
    requestedUrl: url,
    canonicalUrl: url,
    status: 'indexed',
    documentType: 'job',
    title: String(posting.title ?? ''),
    mainContent: String(posting.description ?? ''),
    structuredData: [posting],
    indexedAt: observedAt,
  }).returning();
  documentIds.push(document.id);
  await projectJobPostings(database, {
    documentId: document.id,
    documentStatus: 'indexed',
    postings: extractJobPostings([posting], url, observedAt.toISOString()),
    sourceType,
    observedAt,
  });
  return document.id;
}

const acmeBody = 'We are hiring a senior React Native engineer to build our mobile client applications across iOS and Android. '.repeat(4);

suite('Clarity Jobs corpus', () => {
  let acmeCareersDocumentId = '';

  beforeAll(async () => {
    connectPostgres(databaseUrl);
    const database = getDb();
    await database.delete(searchDocuments).where(inArray(searchDocuments.canonicalUrl, [
      'https://acme.example/careers/react-native',
      'https://boards.greenhouse.io/acme/jobs/1042',
      'https://acme.example/careers/expired-analyst',
      'https://acme.example/careers/abandoned-writer',
      'https://nordic.example/jobs/designer',
      'https://acme.example/careers/vanishing-role',
      firstPartyUrl,
    ]));
    const [site] = await database.insert(searchSites).values({
      id: crypto.randomUUID(),
      ownerAccountId: 'test-account',
      origin: 'https://mention.earth',
      verifiedDomainId: 'test-verified-domain',
    }).onConflictDoUpdate({
      target: [searchSites.ownerAccountId, searchSites.origin],
      set: { updatedAt: new Date() },
    }).returning();
    firstPartySiteId = site.id;

    acmeCareersDocumentId = await seed({
      url: 'https://acme.example/careers/react-native',
      posting: jobPosting({
        title: 'Senior React Native Engineer',
        description: acmeBody,
        identifier: { '@type': 'PropertyValue', name: 'Greenhouse', value: 'REQ-1042' },
        datePosted: daysAgo(3).toISOString(),
        employmentType: 'FULL_TIME',
        jobLocationType: 'TELECOMMUTE',
        applicantLocationRequirements: [{ '@type': 'Country', name: 'Spain' }],
        hiringOrganization: { '@type': 'Organization', name: 'Acme', url: 'https://acme.example' },
        baseSalary: {
          '@type': 'MonetaryAmount', currency: 'EUR',
          value: { '@type': 'QuantitativeValue', minValue: 70000, maxValue: 90000, unitText: 'YEAR' },
        },
        skills: 'React Native, TypeScript',
        url: 'https://acme.example/careers/react-native',
      }),
    });

    await seed({
      url: 'https://boards.greenhouse.io/acme/jobs/1042',
      posting: jobPosting({
        title: 'Senior React Native Engineer',
        description: acmeBody,
        identifier: { '@type': 'PropertyValue', name: 'Greenhouse', value: 'REQ-1042' },
        datePosted: daysAgo(3).toISOString(),
        employmentType: 'FULL_TIME',
        jobLocationType: 'TELECOMMUTE',
        hiringOrganization: { '@type': 'Organization', name: 'Acme', url: 'https://acme.example' },
        url: 'https://boards.greenhouse.io/acme/jobs/1042',
      }),
    });

    await seed({
      url: 'https://acme.example/careers/expired-analyst',
      posting: jobPosting({
        title: 'Data Analyst',
        description: 'Analyse product data for the growth team. '.repeat(10),
        datePosted: daysAgo(90).toISOString(),
        validThrough: daysAgo(10).toISOString(),
        employmentType: 'FULL_TIME',
        jobLocation: { address: { addressLocality: 'Madrid', addressCountry: 'ES' } },
        hiringOrganization: { '@type': 'Organization', name: 'Acme', url: 'https://acme.example' },
      }),
    });

    await seed({
      url: 'https://acme.example/careers/abandoned-writer',
      observedAt: daysAgo(120),
      posting: jobPosting({
        title: 'Technical Writer',
        description: 'Document the platform for developers. '.repeat(10),
        datePosted: daysAgo(150).toISOString(),
        employmentType: 'PART_TIME',
        jobLocation: { address: { addressLocality: 'Madrid', addressCountry: 'ES' } },
        hiringOrganization: { '@type': 'Organization', name: 'Acme', url: 'https://acme.example' },
      }),
    });

    await seed({
      url: 'https://nordic.example/jobs/designer',
      sourceType: 'verified_site',
      posting: jobPosting({
        title: 'Product Designer',
        description: 'Design the Nordic product experience end to end. '.repeat(10),
        datePosted: daysAgo(1).toISOString(),
        employmentType: 'CONTRACTOR',
        jobLocation: { address: { addressLocality: 'Oslo', addressCountry: 'Norway' } },
        hiringOrganization: { '@type': 'Organization', name: 'Nordic', url: 'https://nordic.example' },
      }),
    });
  });

  afterAll(async () => {
    const database = getDb();
    const clusters = await database.select({ id: jobClusters.id }).from(jobClusters);
    await database.delete(searchDocuments).where(inArray(searchDocuments.id, documentIds));
    await database.delete(searchSites).where(inArray(searchSites.id, [firstPartySiteId]));
    if (clusters.length > 0) await database.delete(jobClusters).where(inArray(jobClusters.id, clusters.map((row) => row.id)));
    await closePostgres();
  });

  async function search(request: Record<string, unknown>) {
    return searchJobs(jobSearchSchema.parse({ mode: 'lexical', ...request }));
  }

  it('groups syndicated copies behind the employer canonical source', async () => {
    const results = await search({ query: 'React Native engineer' });
    const acme = results.data.filter((job) => job.employer.name === 'Acme');
    expect(acme).toHaveLength(1);
    expect(acme[0].source.domain).toBe('acme.example');
    expect(acme[0].otherSources.map((source) => source.domain)).toEqual(['boards.greenhouse.io']);
    expect(acme[0].salary).toEqual({ min: 70000, max: 90000, currency: 'EUR', interval: 'year' });
    expect(acme[0].workplaceType).toBe('remote');
  });

  it('returns every source when duplicates are requested', async () => {
    const results = await search({ query: 'React Native engineer', includeDuplicates: true });
    const domains = results.data.filter((job) => job.employer.name === 'Acme').map((job) => job.source.domain);
    expect(domains.sort()).toEqual(['acme.example', 'boards.greenhouse.io']);
  });

  it('keeps expired and stale listings out of default active results', async () => {
    const results = await search({ query: 'Acme' });
    const titles = results.data.map((job) => job.title);
    expect(titles).not.toContain('Data Analyst');
    expect(titles).not.toContain('Technical Writer');

    const expired = await search({ query: 'Data Analyst', statuses: ['expired'] });
    expect(expired.data.map((job) => job.title)).toContain('Data Analyst');

    const stale = await search({ query: 'Technical Writer', statuses: ['stale'] });
    expect(stale.data.map((job) => job.title)).toContain('Technical Writer');
  });

  it('filters by macro-region, workplace type, employment type and salary', async () => {
    const europe = await search({ locations: ['europe'] });
    const europeTitles = europe.data.map((job) => job.title);
    expect(europeTitles).toContain('Senior React Native Engineer');
    expect(europeTitles).toContain('Product Designer');

    const remote = await search({ workplaceTypes: ['remote'] });
    expect(remote.data.every((job) => job.workplaceType === 'remote')).toBe(true);

    const contract = await search({ employmentTypes: ['contract'] });
    expect(contract.data.map((job) => job.title)).toContain('Product Designer');
    expect(contract.data.map((job) => job.title)).not.toContain('Senior React Native Engineer');

    const wellPaid = await search({ salary: { min: 65_000, currency: 'EUR', interval: 'year' } });
    expect(wellPaid.data.map((job) => job.title)).toEqual(['Senior React Native Engineer']);

    const outOfRange = await search({ salary: { min: 200_000, currency: 'EUR', interval: 'year' } });
    expect(outOfRange.data).toEqual([]);

    const oslo = await search({ locations: ['Oslo'] });
    expect(oslo.data.map((job) => job.title)).toEqual(['Product Designer']);
  });

  it('filters by publication window and employer', async () => {
    const thisWeek = await search({ publishedAfter: daysAgo(7).toISOString() });
    const titles = thisWeek.data.map((job) => job.title);
    expect(titles).toContain('Senior React Native Engineer');
    expect(titles).toContain('Product Designer');

    const byEmployer = await search({ employers: ['nordic.example'] });
    expect(byEmployer.data.map((job) => job.title)).toEqual(['Product Designer']);

    const byDomain = await search({ sourceDomains: ['nordic.example'] });
    expect(byDomain.data.map((job) => job.title)).toEqual(['Product Designer']);
  });

  it('resolves a listing by its canonical URL and keeps its sources', async () => {
    const job = await getJobPostingByUrl('https://acme.example/careers/react-native');
    expect(job?.title).toBe('Senior React Native Engineer');
    expect(job?.otherSources).toHaveLength(1);
    expect(job?.evidence.salary?.source).toBe('json_ld');
  });

  it('withdraws a closed listing without discarding the syndicated source', async () => {
    await closeJobPostingsForDocument(getDb(), acmeCareersDocumentId, 'source_closed');
    const results = await search({ query: 'React Native engineer' });
    const acme = results.data.filter((job) => job.employer.name === 'Acme');
    expect(acme).toHaveLength(1);
    expect(acme[0].source.domain).toBe('boards.greenhouse.io');

    const closed = await search({ query: 'React Native engineer', statuses: ['closed'], includeDuplicates: true });
    expect(closed.data.map((job) => job.source.domain)).toContain('acme.example');
  });

  it('reconciles stored statuses with the lifecycle policy', async () => {
    const sweep = await sweepJobLifecycle();
    expect(sweep.expired).toBeGreaterThanOrEqual(0);
    const rows = await getDb().select({ status: jobPostings.status, url: jobPostings.canonicalUrl })
      .from(jobPostings).where(inArray(jobPostings.documentId, documentIds));
    const byUrl = new Map(rows.map((row) => [row.url, row.status]));
    expect(byUrl.get('https://acme.example/careers/expired-analyst')).toBe('expired');
    expect(byUrl.get('https://acme.example/careers/abandoned-writer')).toBe('stale');
    expect(byUrl.get('https://acme.example/careers/react-native')).toBe('closed');
  });

  it('fuses lexical and semantic relevance when embeddings are available', async () => {
    const document = await getDb().select({ id: searchDocuments.id }).from(searchDocuments)
      .where(inArray(searchDocuments.canonicalUrl, ['https://nordic.example/jobs/designer']));
    await replaceDocumentChunks(
      getDb(),
      document[0].id,
      [{ start: 0, end: 40, text: 'Design the Nordic product experience.' }],
      [testEmbedding],
      'test-chunker',
    );

    const semantic = await searchJobs(jobSearchSchema.parse({ query: 'product design role', mode: 'semantic' }));
    expect(semantic.mode).toBe('semantic');
    expect(semantic.data.map((job) => job.title)).toEqual(['Product Designer']);

    const hybrid = await searchJobs(jobSearchSchema.parse({ query: 'Product Designer', mode: 'hybrid' }));
    expect(hybrid.data.map((job) => job.title)).toContain('Product Designer');
    expect(hybrid.degraded).toBeUndefined();
  });

  it('degrades hybrid search to lexical when the embedding route is unavailable', async () => {
    vi.mocked(createOxyEmbeddings).mockRejectedValueOnce(new Error('embedding route unavailable'));
    const results = await searchJobs(jobSearchSchema.parse({ query: 'Product Designer', mode: 'hybrid' }));
    expect(results.degraded).toEqual({ from: 'hybrid', to: 'lexical', reason: 'embedding_route_unavailable' });
    expect(results.data.map((job) => job.title)).toContain('Product Designer');

    vi.mocked(createOxyEmbeddings).mockRejectedValueOnce(new Error('embedding route unavailable'));
    await expect(searchJobs(jobSearchSchema.parse({ query: 'Product Designer', mode: 'semantic' })))
      .rejects.toMatchObject({ status: 503, code: 'semantic_unavailable' });
  });

  it('indexes a first-party listing handed over through the ingestion boundary', async () => {
    const payload = jobPosting({
      title: 'Community Manager',
      description: 'Grow and support the Mention community across the network. '.repeat(8),
      identifier: 'MENTION-77',
      datePosted: daysAgo(1).toISOString(),
      employmentType: 'FULL_TIME',
      jobLocationType: 'TELECOMMUTE',
      applicantLocationRequirements: [{ '@type': 'Country', name: 'Portugal' }],
      hiringOrganization: { '@type': 'Organization', name: 'Mention', url: 'https://mention.earth' },
      url: firstPartyUrl,
    });
    const first = await ingestJobPosting({
      canonicalUrl: firstPartyUrl,
      structuredData: [payload],
      siteId: firstPartySiteId,
      sourceType: 'first_party',
      submittedByApplicationId: 'application-under-test',
      observedAt: now,
    });
    documentIds.push(first.documentId);
    // Re-publishing the same listing converges instead of duplicating it.
    const second = await ingestJobPosting({
      canonicalUrl: firstPartyUrl,
      structuredData: [payload],
      siteId: firstPartySiteId,
      sourceType: 'first_party',
      submittedByApplicationId: 'application-under-test',
      observedAt: now,
    });
    expect(second.documentId).toBe(first.documentId);
    expect(second.jobPostingIds).toEqual(first.jobPostingIds);

    const results = await search({ query: 'community manager' });
    const ingested = results.data.find((job) => job.employer.name === 'Mention');
    expect(ingested).toMatchObject({
      title: 'Community Manager',
      workplaceType: 'remote',
      source: { type: 'first_party', domain: 'mention.earth' },
    });
    expect(ingested?.evidence.title?.source).toBe('api');

    const portugal = await search({ locations: ['Portugal'], query: 'community manager' });
    expect(portugal.data.map((job) => job.title)).toContain('Community Manager');

    await closeJobPostingsForDocument(getDb(), first.documentId, 'source_closed');
    const afterClose = await search({ query: 'community manager' });
    expect(afterClose.data.map((job) => job.employer.name)).not.toContain('Mention');
  });

  it('closes a listing that disappeared from its page on the next crawl', async () => {
    const url = 'https://acme.example/careers/vanishing-role';
    const documentId = await seed({
      url,
      posting: jobPosting({
        title: 'Vanishing Role',
        description: 'A role that the employer removes from the careers page. '.repeat(8),
        datePosted: daysAgo(2).toISOString(),
        employmentType: 'FULL_TIME',
        jobLocation: { address: { addressLocality: 'Valencia', addressCountry: 'ES' } },
        hiringOrganization: { '@type': 'Organization', name: 'Acme', url: 'https://acme.example' },
      }),
    });
    expect((await search({ query: 'Vanishing Role' })).data).toHaveLength(1);

    // The page still resolves, but no longer carries a JobPosting.
    await projectJobPostings(getDb(), {
      documentId,
      documentStatus: 'indexed',
      postings: [],
      sourceType: 'web',
      observedAt: now,
    });

    expect((await search({ query: 'Vanishing Role' })).data).toEqual([]);
    const [row] = await getDb().select({ status: jobPostings.status, reason: jobPostings.closureReason })
      .from(jobPostings).where(inArray(jobPostings.canonicalUrl, [url]));
    expect(row).toMatchObject({ status: 'closed', reason: 'posting_absent' });
  });

  it('records an abuse report without storing who reported it', async () => {
    const [job] = await getDb().select({ id: jobPostings.id }).from(jobPostings)
      .where(inArray(jobPostings.canonicalUrl, ['https://nordic.example/jobs/designer']));
    expect(await reportJobPosting(job.id, { reason: 'scam', detail: 'Asks for payment up front.' })).toBe(true);
    expect(await reportJobPosting('missing-job-id', { reason: 'scam' })).toBe(false);

    const rows = await getDb().select().from(jobReports).where(inArray(jobReports.jobPostingId, [job.id]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'scam', status: 'open' });
    expect(Object.keys(rows[0]).sort()).toEqual(['createdAt', 'detail', 'id', 'jobPostingId', 'reason', 'status']);
  });

  it('reports corpus health without any per-viewer counter', async () => {
    const stats = await jobCorpusStats();
    expect(stats.active).toBeGreaterThan(0);
    expect(stats.bySourceType.verified_site).toBeGreaterThan(0);
    expect(Object.keys(stats)).toEqual(['active', 'byStatus', 'bySourceType', 'withSalary', 'grouped', 'clusters']);
  });
});
