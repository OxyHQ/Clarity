import { Readable } from 'node:stream';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePostgres, connectPostgres, getDb } from '../db/index.js';
import {
  crawlJobs,
  crawlPages,
  fetchAttempts,
  searchDocuments,
  searchUsageEvents,
  searchUsageRollups,
} from '../db/schema/index.js';
import {
  leaseNextPage,
  ownsPageLease,
  processPage,
  recoverExpiredLeases,
  renewPageLease,
} from '../worker.js';

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock('@oxy.so/core/server', async (original) => ({ ...(await original<object>()), safeFetch }));
vi.mock('../search/chunking.js', async (original) => ({
  ...(await original<object>()),
  embedChunks: async () => undefined,
}));
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;
const owner = `lease-tests-${crypto.randomUUID()}`;
const jobIds: string[] = [];
const urls: string[] = [];

suite('crawl worker lease recovery on PostgreSQL', () => {
  beforeAll(() => {
    if (new URL(databaseUrl).pathname !== '/clarity_ci')
      throw new Error('Tests require clarity_ci');
    connectPostgres(databaseUrl);
  });
  afterEach(async () => {
    if (jobIds.length)
      await getDb()
        .delete(crawlJobs)
        .where(inArray(crawlJobs.id, jobIds.splice(0)));
    if (urls.length)
      await getDb()
        .delete(searchDocuments)
        .where(inArray(searchDocuments.canonicalUrl, urls.splice(0)));
    await getDb().delete(searchUsageEvents).where(eq(searchUsageEvents.ownerAccountId, owner));
    await getDb().delete(searchUsageRollups).where(eq(searchUsageRollups.ownerAccountId, owner));
    safeFetch.mockReset();
  });
  afterAll(closePostgres);

  async function page(
    options: {
      status?: string;
      attempts?: number;
      expired?: boolean;
      account?: string;
      jobStatus?: string;
    } = {},
  ) {
    const jobId = crypto.randomUUID();
    jobIds.push(jobId);
    await getDb()
      .insert(crawlJobs)
      .values({
        id: jobId,
        ownerAccountId: options.account ?? owner,
        applicationId: owner,
        kind: 'urls',
        status: options.jobStatus ?? 'queued',
        idempotencyKey: jobId,
        pagesDiscovered: 1,
      });
    const status = options.status ?? 'queued';
    const url = `https://lease-tests.example/${crypto.randomUUID()}`;
    urls.push(url);
    const [row] = await getDb()
      .insert(crawlPages)
      .values({
        id: crypto.randomUUID(),
        jobId,
        url,
        discoverySource: 'api',
        status,
        attemptCount: options.attempts ?? (status === 'fetching' ? 1 : 0),
        availableAt: new Date(Date.now() - 5000),
        ...(status === 'fetching'
          ? {
              leaseOwner: 'dead-worker',
              leaseExpiresAt: new Date(Date.now() + (options.expired ? -5000 : 60000)),
            }
          : {}),
      })
      .returning();
    return row;
  }

  it('reclaims stale fetching slots and lets queued work advance after a crash', async () => {
    const stale = await page({ status: 'fetching', expired: true });
    await page({ status: 'fetching', expired: true });
    const queued = await page();
    await getDb().insert(fetchAttempts).values({
      id: crypto.randomUUID(),
      crawlPageId: stale.id,
      attempt: 1,
      fetchMode: 'http',
      status: 'running',
    });
    const claimed = await leaseNextPage();
    const [recovered] = await getDb().select().from(crawlPages).where(eq(crawlPages.id, stale.id));
    expect(recovered).toMatchObject({
      status: 'retry',
      leaseOwner: null,
      lastErrorCode: 'lease_expired',
    });
    const [attempt] = await getDb()
      .select()
      .from(fetchAttempts)
      .where(eq(fetchAttempts.crawlPageId, stale.id));
    expect(attempt.status).toBe('failed');
    expect(claimed?.id).toBe(queued.id);
  });

  it('ends exhausted claims instead of retrying them forever', async () => {
    const stale = await page({
      status: 'fetching',
      expired: true,
      attempts: 3,
      jobStatus: 'running',
    });
    await recoverExpiredLeases();
    const [p] = await getDb().select().from(crawlPages).where(eq(crawlPages.id, stale.id));
    const [j] = await getDb().select().from(crawlJobs).where(eq(crawlJobs.id, stale.jobId));
    expect(p.status).toBe('failed');
    expect(j.status).toBe('partial');
    expect(j.finishedAt).toBeTruthy();
  });

  it('keeps a mixed operation running until its recovered page finishes', async () => {
    const retryable = await page({ status: 'fetching', expired: true, jobStatus: 'running' });
    await getDb()
      .update(crawlJobs)
      .set({ pagesDiscovered: 2 })
      .where(eq(crawlJobs.id, retryable.jobId));
    await getDb()
      .insert(crawlPages)
      .values({
        ...retryable,
        id: crypto.randomUUID(),
        url: `${retryable.url}/exhausted`,
        attemptCount: 3,
      });
    await recoverExpiredLeases();
    const [running] = await getDb()
      .select()
      .from(crawlJobs)
      .where(eq(crawlJobs.id, retryable.jobId));
    expect(running).toMatchObject({ status: 'running', pagesCompleted: 0, finishedAt: null });
    const claim = await leaseNextPage();
    if (!claim) throw new Error('Expected the recovered page to be leased');
    safeFetch.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/html' },
      finalUrl: claim.url,
      response: Readable.from([
        '<html><head><title>Recovered</title></head><body>Article</body></html>',
      ]),
    });
    await processPage(claim);
    const [finished] = await getDb()
      .select()
      .from(crawlJobs)
      .where(eq(crawlJobs.id, retryable.jobId));
    expect(finished).toMatchObject({ status: 'partial', pagesCompleted: 1 });
    expect(finished.finishedAt).toBeTruthy();
  });

  it('renews a live claim but never revives an expired or superseded one', async () => {
    const live = await page({ status: 'fetching' });
    const stale = await page({ status: 'fetching', expired: true });
    await renewPageLease(live);
    await renewPageLease(stale);
    expect(await getDb().transaction((tx) => ownsPageLease(tx, live))).toBe(true);
    expect(await getDb().transaction((tx) => ownsPageLease(tx, stale))).toBe(false);
    await getDb()
      .update(crawlPages)
      .set({ attemptCount: live.attemptCount + 1 })
      .where(eq(crawlPages.id, live.id));
    expect(await getDb().transaction((tx) => ownsPageLease(tx, live))).toBe(false);
  });

  it('does not let a saturated account block a different account', async () => {
    await page({ status: 'fetching' });
    await page({ status: 'fetching' });
    await page();
    const other = await page({ account: `${owner}-other` });
    expect((await leaseNextPage())?.id).toBe(other.id);
  });

  it('concurrent claimers respect owner capacity without claiming the same page twice', async () => {
    for (let index = 0; index < 6; index += 1) await page();
    for (let index = 0; index < 6; index += 1) await page({ account: `${owner}-other` });
    const claimed = (await Promise.all(Array.from({ length: 6 }, () => leaseNextPage()))).filter(
      Boolean,
    );
    expect(new Set(claimed.map((entry) => entry?.id)).size).toBe(claimed.length);
    const active = await getDb()
      .select({ owner: crawlJobs.ownerAccountId })
      .from(crawlPages)
      .innerJoin(crawlJobs, eq(crawlJobs.id, crawlPages.jobId))
      .where(and(inArray(crawlPages.jobId, jobIds), eq(crawlPages.status, 'fetching')));
    expect(active.length).toBeGreaterThan(0);
    expect(active.filter((entry) => entry.owner === owner).length).toBeLessThanOrEqual(2);
    expect(active.filter((entry) => entry.owner === `${owner}-other`).length).toBeLessThanOrEqual(
      2,
    );
  });

  it('serves a newly requested preview before historical bulk work', async () => {
    const bulk = await page();
    const visible = await page();
    await getDb()
      .update(crawlPages)
      .set({ availableAt: new Date('2020-01-01') })
      .where(eq(crawlPages.id, bulk.id));
    await getDb().update(crawlPages).set({ priority: 1 }).where(eq(crawlPages.id, visible.id));
    expect((await leaseNextPage())?.id).toBe(visible.id);
    expect((await leaseNextPage())?.id).toBe(bulk.id);
  });

  it('never lets priority bypass retry backoff', async () => {
    const retry = await page({ status: 'retry', attempts: 1 });
    await getDb()
      .update(crawlPages)
      .set({ priority: 1, availableAt: new Date(Date.now() + 60000) })
      .where(eq(crawlPages.id, retry.id));
    const ready = await page();
    expect((await leaseNextPage())?.id).toBe(ready.id);
    expect(await leaseNextPage()).toBeUndefined();
  });

  it('does not claim cancelled jobs', async () => {
    await page({ jobStatus: 'cancelled' });
    expect(await leaseNextPage()).toBeUndefined();
  });

  it('publishes the extracted rich document and completes its claimed operation', async () => {
    const queued = await page();
    const claim = await leaseNextPage();
    expect(claim?.id).toBe(queued.id);
    if (!claim) throw new Error('Expected a leased page');
    safeFetch.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/html' },
      finalUrl: claim.url,
      response: Readable.from([
        '<html><head><title>Real article title</title><meta name="description" content="Article summary"><meta property="og:image" content="https://lease-tests.example/cover.jpg"></head><body><p>Article text.</p></body></html>',
      ]),
    });
    await processPage(claim);
    const [document] = await getDb()
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.canonicalUrl, claim.url));
    expect(document).toMatchObject({
      status: 'indexed',
      title: 'Real article title',
      description: 'Article summary',
      imageUrl: 'https://lease-tests.example/cover.jpg',
    });
    const [job] = await getDb().select().from(crawlJobs).where(eq(crawlJobs.id, claim.jobId));
    expect(job).toMatchObject({ status: 'succeeded', pagesCompleted: 1 });
  });

  it('drops a late successful response after another worker has reclaimed the page', async () => {
    const claim = await page({ status: 'fetching' });
    let finish: (() => void) | undefined;
    safeFetch.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        finalUrl: claim.url,
        response: Readable.from([
          '<html><head><title>Late response</title></head><body><p>Article</p></body></html>',
        ]),
      };
    });
    const processing = processPage(claim);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await getDb()
      .update(crawlPages)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(crawlPages.id, claim.id));
    await recoverExpiredLeases();
    finish?.();
    await processing;
    expect(
      await getDb()
        .select()
        .from(searchDocuments)
        .where(eq(searchDocuments.canonicalUrl, claim.url)),
    ).toHaveLength(0);
    const [current] = await getDb().select().from(crawlPages).where(eq(crawlPages.id, claim.id));
    expect(current.status).toBe('retry');
  });

  it('bounds the entire response body and retries an interrupted stream', async () => {
    const claim = await page({ status: 'fetching' });
    const controller = new AbortController();
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const body = new Readable({
      read() {
        // The test pushes chunks itself; nothing to pull.
      },
    });
    safeFetch.mockImplementation(async (_url, options) => {
      options.signal.addEventListener(
        'abort',
        () => body.destroy(new Error('fetch deadline exceeded')),
        { once: true },
      );
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        finalUrl: claim.url,
        response: body,
      };
    });
    try {
      const processing = processPage(claim);
      await vi.waitFor(() => expect(safeFetch).toHaveBeenCalled());
      expect(deadline).toHaveBeenCalledWith(30_000);
      body.push('<html><head>');
      controller.abort();
      await processing;
      const [current] = await getDb().select().from(crawlPages).where(eq(crawlPages.id, claim.id));
      expect(current).toMatchObject({
        status: 'retry',
        leaseOwner: null,
        lastErrorCode: 'fetch_failed',
      });
    } finally {
      deadline.mockRestore();
      body.destroy();
    }
  });

  it('does not fetch or charge a claim that already expired', async () => {
    const stale = await page({ status: 'fetching', expired: true });
    await processPage(stale);
    expect(safeFetch).not.toHaveBeenCalled();
    expect(
      await getDb()
        .select()
        .from(searchUsageEvents)
        .where(
          and(
            eq(searchUsageEvents.ownerAccountId, owner),
            eq(searchUsageEvents.operation, 'fetch_started'),
          ),
        ),
    ).toHaveLength(0);
  });
});
