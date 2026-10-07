import type { ResolveResult } from '@clarity.surf/sdk';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePostgres, connectPostgres, getDb } from '../../../db/index.js';
import { crawlJobs, crawlPages, searchDocuments } from '../../../db/schema/index.js';
import type { ClarityResourcePrincipal } from '../../../middleware/resource-auth.js';

let principal: ClarityResourcePrincipal;
vi.mock('../../../middleware/resource-auth.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../middleware/resource-auth.js')>(),
  authenticateResource: (req: Request, _res: Response, next: NextFunction) => { req.resourcePrincipal = principal; next(); },
  requireResourceRequestRate: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
const { default: router } = await import('../search-platform.js');
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
if (databaseUrl && new URL(databaseUrl).pathname !== '/clarity_ci') throw new Error('Use only clarity_ci');
const suite = databaseUrl ? describe : describe.skip;
const owner = `resolve-test-${crypto.randomUUID()}`;
const urls = ['https://resolve-test.example/a', 'https://resolve-test.example/b', 'https://resolve-test.example/c'];
let server: Server;
let origin: string;
const bodyOf = (response: globalThis.Response) => response.json() as Promise<{ data: ResolveResult[] }>;
const resolve = (requested: string[], waitMs = 0, key?: string) => fetch(`${origin}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify({ urls: requested, waitMs }) });

suite('resolve queue ownership on PostgreSQL and HTTP', () => {
  beforeAll(async () => {
    connectPostgres(databaseUrl);
    const app = express(); app.use(express.json()); app.use(router);
    server = app.listen(0);
    await new Promise((done) => server.once('listening', done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(async () => {
    principal = { active: true, accountId: owner, applicationId: 'app-a', credentialId: 'credential-a', tier: 'external', environment: 'test', scopes: ['clarity:index'], permissions: [] };
    await getDb().delete(crawlJobs).where(eq(crawlJobs.ownerAccountId, owner));
    await getDb().delete(searchDocuments).where(eq(searchDocuments.canonicalUrl, urls[0]));
  });
  afterAll(async () => {
    await getDb().delete(crawlJobs).where(eq(crawlJobs.ownerAccountId, owner));
    await getDb().delete(searchDocuments).where(eq(searchDocuments.canonicalUrl, urls[0]));
    await new Promise<void>((done) => server.close(() => done()));
    await closePostgres();
  });
  it('concurrent overlapping reads reuse each pending URL across API replicas', async () => {
    principal = { ...principal, tier: 'internal' };
    const responses = await Promise.all([resolve([urls[0], urls[1], urls[0]]), resolve([urls[1], urls[2]]), resolve([urls[0]])]);
    expect(responses.map((response) => response.status)).toEqual([202, 202, 202]);
    const bodies = await Promise.all(responses.map((response) => bodyOf(response)));
    const pages = await getDb().select({ url: crawlPages.url }).from(crawlPages).innerJoin(crawlJobs, eq(crawlJobs.id, crawlPages.jobId)).where(eq(crawlJobs.ownerAccountId, owner));
    expect(pages.map((page) => page.url).sort()).toEqual(urls);
    expect(bodies[0].data[1].operationId).toBe(bodies[1].data[0].operationId);
    expect(bodies[0].data[0].operationId).toBe(bodies[2].data[0].operationId);
  });
  it('does not borrow another application\'s operation', async () => {
    const first = await bodyOf(await resolve([urls[0]]));
    principal = { ...principal, applicationId: 'app-b' };
    const second = await bodyOf(await resolve([urls[0]]));
    expect(second.data[0].operationId).not.toBe(first.data[0].operationId);
  });
  it('keeps resolved documents in a mixed response when active crawl quota is full', async () => {
    await resolve([urls[1]]); await resolve([urls[2]]);
    await getDb().insert(searchDocuments).values({ id: crypto.randomUUID(), canonicalUrl: urls[0], requestedUrl: urls[0], status: 'indexed', title: 'Already fetched' });
    const response = await resolve([urls[0], 'https://resolve-test.example/new']);
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.data[0].document.title).toBe('Already fetched');
    expect(body.data[1]).toMatchObject({ status: 'throttled', error: { code: 'active_crawl_quota_exceeded', retryable: true } });
    expect(body.data[1].operationId).toBeUndefined();
  });
  it('still rejects an entirely unqueued request when active quota is full', async () => {
    await resolve([urls[0]]); await resolve([urls[1]]);
    expect((await resolve([urls[2]])).status).toBe(429);
    expect((await resolve([urls[0]])).status).toBe(202);
  });
  it('replays explicit keys without confusing work borrowed from another batch', async () => {
    const borrowed = await bodyOf(await resolve([urls[0]]));
    const first = await bodyOf(await resolve([urls[0], urls[1]], 0, 'stable-client-key'));
    const repeated = await bodyOf(await resolve([urls[1], urls[0]], 0, 'stable-client-key'));
    expect(repeated.data.map((item) => item.operationId)).toEqual(first.data.map((item) => item.operationId).reverse());
    await getDb().update(crawlJobs).set({ status: 'failed' }).where(eq(crawlJobs.id, borrowed.data[0].operationId));
    const afterFailure = await bodyOf(await resolve([urls[0], urls[1]], 0, 'stable-client-key'));
    expect(afterFailure.data.map((item) => item.status)).toEqual(['queued', 'queued']);
    expect(afterFailure.data[0].operationId).not.toBe(borrowed.data[0].operationId);
    expect(afterFailure.data[1].operationId).toBe(first.data[1].operationId);
  });
  it('promotes a currently requested queued page without changing retry schedules or unrelated bulk pages', async () => {
    const queued = await fetch(`${origin}/index/urls`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'bulk-import' }, body: JSON.stringify({ urls }) });
    expect(queued.status).toBe(202);
    const pages = await getDb().select().from(crawlPages).innerJoin(crawlJobs, eq(crawlJobs.id, crawlPages.jobId)).where(eq(crawlJobs.ownerAccountId, owner));
    const retry = pages.find((row) => row.clarity_crawl_pages.url === urls[1]).clarity_crawl_pages;
    const future = new Date(Date.now() + 60000);
    await getDb().update(crawlPages).set({ status: 'retry', attemptCount: 1, availableAt: future }).where(eq(crawlPages.id, retry.id));
    await resolve([urls[0], urls[1]]);
    const updated = await getDb().select({ url: crawlPages.url, priority: crawlPages.priority, availableAt: crawlPages.availableAt }).from(crawlPages).innerJoin(crawlJobs, eq(crawlJobs.id, crawlPages.jobId)).where(eq(crawlJobs.ownerAccountId, owner));
    expect(updated.find((row) => row.url === urls[0]).priority).toBe(1);
    expect(updated.find((row) => row.url === urls[1])).toMatchObject({ priority: 1, availableAt: future });
    expect(updated.find((row) => row.url === urls[2]).priority).toBe(0);
  });
  it('can retry a failed operation instead of reusing it forever', async () => {
    const first = await bodyOf(await resolve([urls[0]]));
    await getDb().update(crawlJobs).set({ status: 'failed' }).where(eq(crawlJobs.id, first.data[0].operationId));
    const next = await bodyOf(await resolve([urls[0]]));
    expect(next.data[0].operationId).not.toBe(first.data[0].operationId);
  });
});
