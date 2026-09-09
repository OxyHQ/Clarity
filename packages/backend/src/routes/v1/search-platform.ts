import { and, desc, eq, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { getDb } from '../../db/index.js';
import {
  crawlJobs, crawlPages, newsStories, newsStoryArticles, searchDocuments, searchSites,
  searchUsageEvents, searchUsageRollups,
} from '../../db/schema/index.js';
import { authenticateResource, requireResourceScope, sendError } from '../../middleware/resource-auth.js';
import { getClarityServiceToken } from '../../lib/clarity-service-auth.js';

const router = Router();
router.use(authenticateResource);

const documentTypes = ['page', 'article', 'news', 'product', 'video', 'event', 'recipe', 'profile', 'documentation', 'other'] as const;
const searchSchema = z.object({
  query: z.string().trim().min(1).max(500),
  mode: z.enum(['lexical', 'semantic', 'hybrid']).default('hybrid'),
  types: z.array(z.enum(documentTypes)).max(documentTypes.length).optional(),
  domains: z.array(z.string().min(1)).max(50).optional(),
  language: z.string().max(35).optional(),
  publishedAfter: z.coerce.date().optional(),
  publishedBefore: z.coerce.date().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
const urlsSchema = z.object({ urls: z.array(z.string().url()).min(1).max(50) });
const resolveSchema = urlsSchema.extend({ waitMs: z.number().int().min(0).max(5_000).optional() });
const createSiteSchema = z.object({
  origin: z.string().url(), verifiedDomainId: z.string().min(1),
  sitemapUrls: z.array(z.string().url()).max(20).default([]), feedUrls: z.array(z.string().url()).max(20).default([]),
});

router.post('/search', requireResourceScope('clarity:search'), async (req, res) => {
  const input = parse(searchSchema, req, res);
  if (!input) return;
  if (input.mode === 'semantic') {
    sendError(res, 503, 'semantic_unavailable', 'Semantic search is unavailable until an embedding route is active', req);
    return;
  }
  const filters = [eq(searchDocuments.status, 'indexed'), eq(searchDocuments.noindex, false), or(
    ilike(searchDocuments.title, `%${escapeLike(input.query)}%`),
    ilike(searchDocuments.description, `%${escapeLike(input.query)}%`),
    ilike(searchDocuments.mainContent, `%${escapeLike(input.query)}%`),
  )];
  if (input.types?.length) filters.push(inArray(searchDocuments.documentType, input.types));
  if (input.language) filters.push(eq(searchDocuments.language, input.language));
  if (input.publishedAfter) filters.push(sql`${searchDocuments.publishedAt} >= ${input.publishedAfter}`);
  if (input.publishedBefore) filters.push(sql`${searchDocuments.publishedAt} <= ${input.publishedBefore}`);
  if (input.domains?.length) filters.push(sql`${searchDocuments.canonicalUrl} similar to ${domainsPattern(input.domains)}`);
  const cursor = decodeCursor(input.cursor);
  if (cursor) filters.push(lt(searchDocuments.id, cursor));
  const rows = await getDb().select().from(searchDocuments).where(and(...filters)).orderBy(desc(searchDocuments.id)).limit(input.limit + 1);
  await recordUsage(req, 'search');
  const hasMore = rows.length > input.limit;
  const data = rows.slice(0, input.limit).map((row) => ({ ...publicDocument(row), snippet: row.description ?? excerpt(row.mainContent), highlights: [], score: 1 }));
  res.json({ data, mode: input.mode, ...(input.mode === 'hybrid' ? { degraded: { from: 'hybrid', to: 'lexical', reason: 'embedding_route_unavailable' } } : {}), ...(hasMore ? { nextCursor: encodeCursor(rows[input.limit - 1].id) } : {}) });
});

router.post('/index/urls', requireResourceScope('clarity:index'), async (req, res) => {
  const input = parse(urlsSchema, req, res);
  if (!input) return;
  const idempotencyKey = requireIdempotency(req, res);
  if (!idempotencyKey) return;
  const job = await createUrlJob(req, input.urls.map(canonicalizePublicUrl), idempotencyKey);
  res.status(202).json(publicJob(job));
});

router.post('/resolve', requireResourceScope('clarity:index'), async (req, res) => {
  const input = parse(resolveSchema, req, res);
  if (!input) return;
  const urls = input.urls.map(canonicalizePublicUrl);
  const rows = await getDb().select().from(searchDocuments).where(inArray(searchDocuments.canonicalUrl, urls));
  const byUrl = new Map(rows.map((row) => [row.canonicalUrl, row]));
  const missing = urls.filter((url) => !byUrl.has(url));
  let jobId: string | undefined;
  if (missing.length) {
    const idempotencyKey = req.header('idempotency-key') || `resolve:${crypto.randomUUID()}`;
    jobId = (await createUrlJob(req, missing, idempotencyKey)).id;
  }
  res.status(missing.length ? 202 : 200).json({ data: urls.map((url) => {
    const document = byUrl.get(url);
    return document ? { url, document: publicDocument(document), status: document.status } : { url, jobId, status: 'queued' };
  }) });
});

router.get('/documents/by-url', requireResourceScope('clarity:search'), async (req, res) => {
  if (typeof req.query.url !== 'string') { sendError(res, 400, 'invalid_request', 'url is required', req); return; }
  const [row] = await getDb().select().from(searchDocuments).where(eq(searchDocuments.canonicalUrl, canonicalizePublicUrl(req.query.url))).limit(1);
  if (!row) { sendError(res, 404, 'document_not_found', 'Document not found', req); return; }
  res.json(publicDocument(row));
});

router.get('/documents/:id', requireResourceScope('clarity:search'), async (req, res) => {
  const [row] = await getDb().select().from(searchDocuments).where(eq(searchDocuments.id, String(req.params.id))).limit(1);
  if (!row) { sendError(res, 404, 'document_not_found', 'Document not found', req); return; }
  res.json(publicDocument(row));
});

router.get('/news', requireResourceScope('clarity:search'), async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const stories = await getDb().select().from(newsStories).orderBy(desc(newsStories.lastPublishedAt), desc(newsStories.rankingScore)).limit(limit);
  const articles = stories.length ? await getDb().select({ storyId: newsStoryArticles.storyId, document: searchDocuments }).from(newsStoryArticles).innerJoin(searchDocuments, eq(newsStoryArticles.documentId, searchDocuments.id)).where(inArray(newsStoryArticles.storyId, stories.map((story) => story.id))) : [];
  res.json({ data: stories.map((story) => ({ ...story, articles: articles.filter((item) => item.storyId === story.id).map((item) => ({ ...publicDocument(item.document), highlights: [], score: 1 })) })) });
});

router.get('/sites', requireResourceScope('clarity:sites:manage'), async (req, res) => {
  const principal = req.resourcePrincipal;
  if (!principal) return;
  const rows = await getDb().select().from(searchSites).where(eq(searchSites.ownerAccountId, principal.accountId)).orderBy(desc(searchSites.id)).limit(100);
  res.json({ data: rows.map(publicSite) });
});

router.post('/sites', requireResourceScope('clarity:sites:manage'), async (req, res) => {
  const input = parse(createSiteSchema, req, res);
  const principal = req.resourcePrincipal;
  const idempotencyKey = requireIdempotency(req, res);
  if (!input || !principal || !idempotencyKey) return;
  const origin = new URL(input.origin).origin;
  if (!await verifyDomainOwnership(principal.accountId, input.verifiedDomainId, new URL(origin).hostname)) {
    sendError(res, 403, 'domain_not_verified', 'The origin is not a verified Oxy domain owned by this account', req);
    return;
  }
  const [site] = await getDb().insert(searchSites).values({ id: crypto.randomUUID(), ownerAccountId: principal.accountId, origin, verifiedDomainId: input.verifiedDomainId, sitemapUrls: input.sitemapUrls, feedUrls: input.feedUrls }).onConflictDoUpdate({ target: [searchSites.ownerAccountId, searchSites.origin], set: { updatedAt: sql`now()` } }).returning();
  res.status(201).json(publicSite(site));
});

router.post('/sites/:id/crawls', requireResourceScope('clarity:sites:manage'), async (req, res) => {
  const principal = req.resourcePrincipal;
  const idempotencyKey = requireIdempotency(req, res);
  if (!principal || !idempotencyKey) return;
  const [site] = await getDb().select().from(searchSites).where(and(eq(searchSites.id, String(req.params.id)), eq(searchSites.ownerAccountId, principal.accountId))).limit(1);
  if (!site) { sendError(res, 404, 'site_not_found', 'Site not found', req); return; }
  const [job] = await getDb().insert(crawlJobs).values({ id: crypto.randomUUID(), ownerAccountId: principal.accountId, applicationId: principal.applicationId, credentialId: principal.credentialId, siteId: site.id, kind: 'site', idempotencyKey, requestedUrls: [site.origin] }).onConflictDoUpdate({ target: [crawlJobs.ownerAccountId, crawlJobs.applicationId, crawlJobs.idempotencyKey], set: { updatedAt: sql`now()` } }).returning();
  res.status(202).json(publicJob(job));
});

router.get('/jobs/:id', requireResourceScope('clarity:index'), async (req, res) => {
  const principal = req.resourcePrincipal;
  if (!principal) return;
  const [job] = await getDb().select().from(crawlJobs).where(and(eq(crawlJobs.id, String(req.params.id)), eq(crawlJobs.ownerAccountId, principal.accountId))).limit(1);
  if (!job) { sendError(res, 404, 'job_not_found', 'Job not found', req); return; }
  res.json(publicJob(job));
});

router.post('/jobs/:id/cancel', requireResourceScope('clarity:index'), async (req, res) => {
  const principal = req.resourcePrincipal;
  if (!principal) return;
  const [job] = await getDb().update(crawlJobs).set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(crawlJobs.id, String(req.params.id)), eq(crawlJobs.ownerAccountId, principal.accountId), inArray(crawlJobs.status, ['queued', 'running']))).returning();
  if (!job) { sendError(res, 409, 'job_not_cancellable', 'Job is missing or already terminal', req); return; }
  res.json(publicJob(job));
});

router.get('/usage', requireResourceScope('clarity:usage:read'), async (req, res) => {
  const principal = req.resourcePrincipal;
  if (!principal) return;
  const data = await getDb().select().from(searchUsageRollups).where(eq(searchUsageRollups.ownerAccountId, principal.accountId)).orderBy(desc(searchUsageRollups.periodStart)).limit(100);
  res.json({ data });
});

router.get('/quotas', requireResourceScope('clarity:usage:read'), (_req, res) => res.json({ searchesPerMonth: 10_000, fetchesPerMonth: 5_000, sites: 1, activeCrawls: 2, pagesPerCrawl: 5_000, requestsPerMinuteCredential: 60, requestsPerMinuteApplication: 300 }));

async function createUrlJob(req: Request, urls: string[], idempotencyKey: string) {
  const principal = req.resourcePrincipal;
  if (!principal) throw new Error('Resource principal missing after authentication');
  return getDb().transaction(async (tx) => {
    const [job] = await tx.insert(crawlJobs).values({ id: crypto.randomUUID(), ownerAccountId: principal.accountId, applicationId: principal.applicationId, credentialId: principal.credentialId, kind: 'urls', idempotencyKey, requestedUrls: urls, pagesDiscovered: urls.length }).onConflictDoUpdate({ target: [crawlJobs.ownerAccountId, crawlJobs.applicationId, crawlJobs.idempotencyKey], set: { updatedAt: sql`now()` } }).returning();
    await tx.insert(crawlPages).values(urls.map((url) => ({ id: crypto.randomUUID(), jobId: job.id, url, discoverySource: 'api' }))).onConflictDoNothing();
    return job;
  });
}

async function recordUsage(req: Request, operation: 'search') {
  const principal = req.resourcePrincipal;
  if (!principal) return;
  await getDb().insert(searchUsageEvents).values({ id: crypto.randomUUID(), ownerAccountId: principal.accountId, applicationId: principal.applicationId, credentialId: principal.credentialId, operation });
}

function parse<T>(schema: z.ZodType<T>, req: Request, res: Response): T | undefined {
  const result = schema.safeParse(req.body);
  if (result.success) return result.data;
  sendError(res, 400, 'invalid_request', 'Request validation failed', req, { issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
  return undefined;
}

function requireIdempotency(req: Request, res: Response): string | undefined {
  const value = req.header('idempotency-key');
  if (value && value.length <= 200) return value;
  sendError(res, 400, 'idempotency_key_required', 'A valid Idempotency-Key header is required', req);
  return undefined;
}

function canonicalizePublicUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP(S) URLs are supported');
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  return url.toString();
}

function publicDocument(row: typeof searchDocuments.$inferSelect) {
  return { id: row.id, canonicalUrl: row.canonicalUrl, requestedUrl: row.requestedUrl, title: row.title ?? undefined, description: row.description ?? undefined, content: row.mainContent ?? undefined, type: row.documentType, status: row.status, language: row.language ?? undefined, publisher: row.publisherName ?? undefined, authors: [], publishedAt: row.publishedAt?.toISOString(), modifiedAt: row.modifiedAt?.toISOString(), imageUrl: row.imageUrl ?? undefined, faviconUrl: row.faviconUrl ?? undefined, indexedAt: row.indexedAt?.toISOString(), evidence: row.fieldEvidence };
}
function publicJob(row: typeof crawlJobs.$inferSelect) { return { id: row.id, kind: row.kind, status: row.status, pagesDiscovered: row.pagesDiscovered, pagesCompleted: row.pagesCompleted, ...(row.errorCode ? { error: { code: row.errorCode, detail: row.errorDetail ?? undefined } } : {}), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }; }
function publicSite(row: typeof searchSites.$inferSelect) { return { id: row.id, origin: row.origin, verifiedDomainId: row.verifiedDomainId, status: row.status, crawlEnabled: row.crawlEnabled, recrawlIntervalSeconds: row.recrawlIntervalSeconds, maxPagesPerCrawl: row.maxPagesPerCrawl, sitemapUrls: row.sitemapUrls, feedUrls: row.feedUrls, nextCrawlAt: row.nextCrawlAt?.toISOString() }; }
function excerpt(value: string | null): string | undefined { return value ? `${value.slice(0, 300)}${value.length > 300 ? '…' : ''}` : undefined; }
function escapeLike(value: string): string { return value.replace(/[\\%_]/g, '\\$&'); }
function domainsPattern(domains: string[]): string { return `https?://(${domains.map((domain) => domain.replace(/[.%]/g, '\\$&')).join('|')})(/|:).*`; }
function encodeCursor(value: string): string { return Buffer.from(value).toString('base64url'); }
function decodeCursor(value?: string): string | undefined { if (!value) return undefined; try { return Buffer.from(value, 'base64url').toString('utf8'); } catch { return undefined; } }

async function verifyDomainOwnership(accountId: string, verifiedDomainId: string, originHost: string): Promise<boolean> {
  const serviceToken = await getClarityServiceToken();
  const response = await fetch(`${(process.env.OXY_API_URL || 'https://api.oxy.so').replace(/\/$/, '')}/auth/resources/domains/verify`, {
    method: 'POST',
    headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, verifiedDomainId, originHost }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return false;
  const result = z.object({ verified: z.boolean() }).safeParse(await response.json());
  return result.success && result.data.verified;
}

export default router;
