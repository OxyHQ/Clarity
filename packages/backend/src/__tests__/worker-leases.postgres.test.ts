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
  enqueueJobRecrawls,
  ownsPageLease,
  processPage,
  recoverExpiredLeases,
  renewPageLease,
} from '../worker.js';

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock('@oxy.so/core/server', async (original) => ({ ...(await original<object>()), safeFetch }));
vi.mock('../search/chunking.js', async (original) => ({
  ...(await original<object>()),
  queueChunkEmbeddings: async () => undefined,
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
      idempotencyKey?: string;
      callerKind?: string;
      callerAuthority?: 'first_party' | 'external';
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
        callerKind: options.callerKind ?? 'service',
        callerAuthority: options.callerAuthority ?? 'external',
        status: options.jobStatus ?? 'queued',
        idempotencyKey: options.idempotencyKey ?? jobId,
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

  it('holds legacy pages without consuming attempts, quota or expired leases during a rolling deployment', async () => {
    const queued = await page({ callerKind: 'legacy' });
    const expired = await page({
      callerKind: 'legacy',
      status: 'fetching',
      expired: true,
      attempts: 3,
    });
    const supplied = await page({
      callerKind: 'legacy',
      callerAuthority: 'first_party',
      status: 'fetching',
    });
    expect(await recoverExpiredLeases()).toBe(0);
    expect(await leaseNextPage()).toBeUndefined();
    await processPage(supplied);
    expect(safeFetch).not.toHaveBeenCalled();
    for (const original of [queued, expired, supplied]) {
      const [current] = await getDb()
        .select()
        .from(crawlPages)
        .where(eq(crawlPages.id, original.id));
      expect(current).toEqual(original);
    }
    expect(
      await getDb()
        .select()
        .from(searchUsageEvents)
        .where(eq(searchUsageEvents.ownerAccountId, owner)),
    ).toHaveLength(0);
    // Only reviewed provenance releases the original page, with its original identity.
    await getDb()
      .update(crawlJobs)
      .set({ callerKind: 'service', callerAuthority: 'first_party' })
      .where(eq(crawlJobs.id, queued.jobId));
    expect((await leaseNextPage())?.id).toBe(queued.id);
  });

  it('admits reviewed external lineage without inventing credential kind and keeps own quotas separate', async () => {
    await page({ status: 'fetching' });
    await page({ status: 'fetching' });
    const external = await page({ callerKind: 'reconciled_legacy_external' });
    expect(await leaseNextPage()).toBeUndefined();
    const own = await page({
      callerKind: 'service',
      callerAuthority: 'first_party',
      account: `${owner}-own`,
    });
    expect((await leaseNextPage())?.id).toBe(own.id);
    const [waiting] = await getDb().select().from(crawlPages).where(eq(crawlPages.id, external.id));
    expect(waiting.status).toBe('queued');
  });

  it('holds unresolved historical recrawls and preserves classified authority when grouping matching owner tuples', async () => {
    const legacy = await page({ callerKind: 'legacy', jobStatus: 'succeeded' });
    const external = await page({
      callerKind: 'reconciled_legacy_external',
      jobStatus: 'succeeded',
    });
    const own = await page({
      callerKind: 'service',
      callerAuthority: 'first_party',
      jobStatus: 'succeeded',
    });
    const dueAt = new Date(Date.now() - 1000);
    for (const original of [legacy, external, own]) {
      await getDb().insert(searchDocuments).values({
        id: crypto.randomUUID(),
        requestedUrl: original.url,
        canonicalUrl: original.url,
        documentType: 'job',
        status: 'indexed',
        nextFetchAt: dueAt,
      });
    }
    expect(await enqueueJobRecrawls()).toBe(2);
    const created = await getDb()
      .select()
      .from(crawlJobs)
      .where(and(eq(crawlJobs.ownerAccountId, owner), eq(crawlJobs.kind, 'recrawl')));
    jobIds.push(...created.map((job) => job.id));
    expect(created).toHaveLength(2);
    expect(created.map((job) => [job.callerAuthority, job.callerKind]).sort()).toEqual([
      ['external', 'reconciled_legacy_external'],
      ['first_party', 'service'],
    ]);
    const [held] = await getDb()
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.canonicalUrl, legacy.url));
    expect(held.nextFetchAt).toEqual(dueAt);
    await getDb()
      .update(crawlJobs)
      .set({ callerKind: 'service', callerAuthority: 'first_party' })
      .where(eq(crawlJobs.id, legacy.jobId));
    expect(await enqueueJobRecrawls()).toBe(1);
    const lineage = await getDb()
      .select()
      .from(crawlJobs)
      .where(and(eq(crawlJobs.ownerAccountId, owner), eq(crawlJobs.kind, 'recrawl')));
    jobIds.push(...lineage.map((job) => job.id));
    expect(lineage.flatMap((job) => job.requestedUrls)).toContain(legacy.url);
  });

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

  describe('a resolve whose URL was fetched after it was asked for', () => {
    const html = () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      response: Readable.from([
        '<html><head><title>Fresh</title></head><body>Article</body></html>',
      ]),
    });

    async function documentFor(url: string, fetchedAt: Date) {
      await getDb().insert(searchDocuments).values({
        id: crypto.randomUUID(),
        requestedUrl: url,
        canonicalUrl: url,
        status: 'indexed',
        documentType: 'article',
        fetchedAt,
        indexedAt: fetchedAt,
      });
    }

    async function claimed(id: string) {
      const claim = await leaseNextPage();
      if (claim?.id !== id) throw new Error('Expected the test page to be leased');
      return claim;
    }

    it('completes without fetching when another request fetched it since', async () => {
      const queued = await page({ idempotencyKey: `resolve:${crypto.randomUUID()}` });
      await documentFor(queued.url, new Date());

      await processPage(await claimed(queued.id));

      expect(safeFetch).not.toHaveBeenCalled();
      const [done] = await getDb().select().from(crawlPages).where(eq(crawlPages.id, queued.id));
      expect(done).toMatchObject({ status: 'succeeded', leaseOwner: null });
      const [job] = await getDb().select().from(crawlJobs).where(eq(crawlJobs.id, queued.jobId));
      expect(job).toMatchObject({ status: 'succeeded', pagesCompleted: 1 });
    });

    it('still fetches when the stored copy is older than the request', async () => {
      const queued = await page({ idempotencyKey: `resolve:${crypto.randomUUID()}` });
      await documentFor(queued.url, new Date(Date.now() - 60 * 60 * 1000));
      safeFetch.mockResolvedValue({ ...html(), finalUrl: queued.url });

      await processPage(await claimed(queued.id));

      expect(safeFetch).toHaveBeenCalledTimes(1);
    });

    it('never skips an explicit index request, which asks for a fresh fetch', async () => {
      const queued = await page({ idempotencyKey: `bulk-${crypto.randomUUID()}` });
      await documentFor(queued.url, new Date());
      safeFetch.mockResolvedValue({ ...html(), finalUrl: queued.url });

      await processPage(await claimed(queued.id));

      expect(safeFetch).toHaveBeenCalledTimes(1);
    });
  });
});
