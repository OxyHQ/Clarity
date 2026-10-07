import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { crawlJobs, crawlPages } from '../../db/schema/index.js';
import { recoverDuplicateResolves } from '../resolve-recovery.js';
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
if (databaseUrl && new URL(databaseUrl).pathname !== '/clarity_ci') throw new Error('Use only clarity_ci');
const suite = databaseUrl ? describe : describe.skip;
const owner = `recovery-test-${crypto.randomUUID()}`;
const before = new Date('2026-10-07T00:00:00Z');
const url = 'https://recover.example/a';
const scope = { ownerAccountId: owner, applicationId: 'app-a', before, limit: 1000 };

suite('duplicate resolve recovery on PostgreSQL', () => {
  beforeAll(() => { connectPostgres(databaseUrl); });
  afterAll(async () => { await getDb().delete(crawlJobs).where(eq(crawlJobs.ownerAccountId, owner)); await closePostgres(); });
  it('previews without writes, keeps in-flight and distinct billing/purpose work, and preserves audit rows', async () => {
    const add = async (options: { status?: string; applicationId?: string; credentialId?: string; explicit?: boolean; fresh?: boolean; extra?: boolean } = {}) => {
      const id = crypto.randomUUID();
      await getDb().insert(crawlJobs).values({ id, ownerAccountId: owner, applicationId: options.applicationId ?? 'app-a', credentialId: options.credentialId ?? 'credential-a', kind: 'urls', idempotencyKey: `${options.explicit ? 'index' : 'resolve'}:${id}`, requestedUrls: [url], pagesDiscovered: options.extra ? 2 : 1 });
      const pageId = crypto.randomUUID();
      await getDb().insert(crawlPages).values({ id: pageId, jobId: id, url, status: options.status ?? 'queued', discoverySource: 'api', attemptCount: options.status === 'fetching' ? 1 : 0, leaseOwner: options.status === 'fetching' ? 'live-worker' : null, leaseExpiresAt: options.status === 'fetching' ? new Date(Date.now() + 60000) : null, createdAt: new Date(options.fresh ? '2026-10-08T00:00:00Z' : '2026-10-01T00:00:00Z') });
      if (options.extra) await getDb().insert(crawlPages).values({ id: crypto.randomUUID(), jobId: id, url: 'https://recover.example/unique', discoverySource: 'api' });
      return { id, pageId };
    };
    const live = await add({ status: 'fetching' });
    const duplicate = await add();
    const mixed = await add({ extra: true });
    const explicit = await add({ explicit: true });
    const otherApp = await add({ applicationId: 'app-b' });
    const otherCredential = await add({ credentialId: 'credential-b' });
    const fresh = await add({ fresh: true });
    const preview = await recoverDuplicateResolves(scope);
    expect(preview).toMatchObject({ apply: false, pages: 2, operationsFinished: 0 });
    const [untouched] = await getDb().select().from(crawlPages).where(eq(crawlPages.id, duplicate.pageId));
    expect(untouched.status).toBe('queued');
    const applied = await recoverDuplicateResolves(scope, true);
    expect(applied).toMatchObject({ pages: 2, operationsFinished: 1 });
    const [cancelled] = await getDb().select().from(crawlJobs).where(eq(crawlJobs.id, duplicate.id));
    expect(cancelled.status).toBe('cancelled');
    const [surviving] = await getDb().select().from(crawlJobs).where(eq(crawlJobs.id, mixed.id));
    expect(surviving.status).toBe('queued');
    for (const item of [live, explicit, otherApp, otherCredential, fresh]) {
      const [page] = await getDb().select().from(crawlPages).where(eq(crawlPages.id, item.pageId));
      expect(page.status).toBe(item === live ? 'fetching' : 'queued');
    }
    const [audit] = await getDb().select().from(crawlPages).where(eq(crawlPages.id, duplicate.pageId));
    expect(audit).toMatchObject({ status: 'failed', lastErrorCode: 'resolve_superseded', lastErrorDetail: `Duplicate resolve; retained page ${live.pageId}` });
    expect((await recoverDuplicateResolves(scope, true)).pages).toBe(0);
  });
  it('keeps the requested page priority when coalescing untouched bulk copies', async () => {
    const pages: string[] = [];
    for (const priority of [0, 1, 0]) {
      const id = crypto.randomUUID(); const pageId = crypto.randomUUID(); pages.push(pageId);
      await getDb().insert(crawlJobs).values({ id, ownerAccountId: owner, applicationId: 'app-a', credentialId: 'credential-a', kind: 'urls', idempotencyKey: `resolve:${id}`, requestedUrls: ['https://recover.example/priority'] });
      await getDb().insert(crawlPages).values({ id: pageId, jobId: id, url: 'https://recover.example/priority', discoverySource: 'api', priority, createdAt: new Date('2026-10-01T00:00:00Z') });
    }
    expect((await recoverDuplicateResolves(scope, true)).pages).toBe(2);
    const [retained] = await getDb().select().from(crawlPages).where(eq(crawlPages.id, pages[1]));
    expect(retained).toMatchObject({ status: 'queued', priority: 1 });
  });
  it('refuses unbounded or incomplete recovery scopes', async () => {
    await expect(recoverDuplicateResolves({ ...scope, ownerAccountId: '' }, true)).rejects.toThrow('scope');
    await expect(recoverDuplicateResolves({ ...scope, limit: 100000 }, true)).rejects.toThrow('scope');
  });
});
