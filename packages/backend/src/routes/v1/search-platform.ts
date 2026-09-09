import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { getDb } from '../../db/index.js';
import {
  crawlJobs, crawlPages, jobFeeds, newsStories, newsStoryArticles, searchDocuments, searchSites,
  searchChunks, searchUsageRollups,
} from '../../db/schema/index.js';
import { authenticateResource, requireResourceScope, sendError } from '../../middleware/resource-auth.js';
import { getClarityServiceToken } from '../../lib/clarity-service-auth.js';
import { createOxyEmbeddings } from '../../lib/oxy-embeddings.js';
import { consumeRequestRate, consumeUsage, effectiveQuota, SANDBOX_QUOTAS, type QuotaMetric } from '../../search/quotas.js';
import {
  canonicalizePublicUrl, decodeSearchCursor, encodeSearchCursor, escapeLike, excerpt,
} from '../../search/query-primitives.js';
import { CLARITY_JOBS_CAPABILITY } from '../../search/jobs/capability.js';
import {
  JobsError, getJobPostingById, getJobPostingByUrl, jobCorpusStats, jobSearchSchema, searchJobs,
} from '../../search/jobs/service.js';
import { closeJobPostingsForDocument, ingestJobPosting } from '../../search/jobs/projection.js';
import { jobReportSchema, reportJobPosting } from '../../search/jobs/reports.js';
import { JOB_FEED_IDENTIFIER_MEANING, JOB_FEED_KINDS, jobFeedUrl } from '../../search/jobs/feeds/endpoints.js';

const router = Router();
router.use(authenticateResource);
router.use(async (req, res, next) => {
  const principal = req.resourcePrincipal;
  if (!principal) return;
  const result = await consumeRequestRate(principal);
  if (!result.accepted) {
    if (result.retryAfterSeconds) res.setHeader('Retry-After', String(result.retryAfterSeconds));
    sendError(res, 429, 'rate_limit_exceeded', 'The request rate limit has been exceeded', req);
    return;
  }
  next();
});

const documentTypes = ['page', 'article', 'news', 'job', 'product', 'video', 'event', 'recipe', 'profile', 'documentation', 'other'] as const;
const searchSchema = z.object({
  query: z.string().trim().min(1).max(500),
  mode: z.enum(['lexical', 'semantic', 'hybrid']).default('hybrid'),
  types: z.array(z.enum(documentTypes)).max(documentTypes.length).optional(),
  domains: z.array(z.string().trim().max(253).regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i)).max(50).optional(),
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
  const principal = req.resourcePrincipal;
  if (!principal) return;
  const usage = await consumeUsage({ principal, operation: 'search' });
  if (!usage.accepted) {
    sendError(res, 429, 'monthly_quota_exceeded', 'The monthly search quota has been exhausted', req, { metric: 'search_month', limit: usage.limit, used: usage.used });
    return;
  }
  let queryEmbedding: number[] | undefined;
  let degraded: { from: 'hybrid'; to: 'lexical'; reason: 'embedding_route_unavailable' } | undefined;
  if (input.mode !== 'lexical') {
    try {
      [queryEmbedding] = await createOxyEmbeddings([input.query]);
    } catch {
      if (input.mode === 'semantic') {
        sendError(res, 503, 'semantic_unavailable', 'Semantic search is temporarily unavailable', req);
        return;
      }
      degraded = { from: 'hybrid', to: 'lexical', reason: 'embedding_route_unavailable' };
    }
  }
  const offset = decodeSearchCursor(input.cursor);
  if (offset === undefined) { sendError(res, 400, 'invalid_cursor', 'The search cursor is invalid', req); return; }
  const ranks = await rankedSearch(input, queryEmbedding, offset);
  const ids = ranks.slice(0, input.limit).map((row) => row.documentId);
  const documents = ids.length ? await getDb().select().from(searchDocuments).where(inArray(searchDocuments.id, ids)) : [];
  const documentsById = new Map(documents.map((row) => [row.id, row]));
  const data = ranks.slice(0, input.limit).flatMap((rank) => {
    const row = documentsById.get(rank.documentId);
    return row ? [{ ...publicDocument(row), snippet: row.description ?? excerpt(row.mainContent), highlights: [], score: Number(rank.score) }] : [];
  });
  res.json({ data, mode: input.mode, ...(degraded ? { degraded } : {}), ...(ranks.length > input.limit ? { nextCursor: encodeSearchCursor(offset + input.limit) } : {}) });
});

type SearchInput = z.infer<typeof searchSchema>;

async function rankedSearch(input: SearchInput, embedding: number[] | undefined, offset: number) {
  const filters: SQL[] = [sql`${searchDocuments.status} = 'indexed'`, sql`${searchDocuments.noindex} = false`];
  if (input.types?.length) filters.push(sql`${searchDocuments.documentType} in (${sql.join(input.types.map((type) => sql`${type}`), sql`, `)})`);
  if (input.language) filters.push(sql`${searchDocuments.language} = ${input.language}`);
  // A raw `sql` parameter carries no column type, so bind timestamps as ISO
  // text with an explicit cast rather than handing the driver a Date.
  if (input.publishedAfter) filters.push(sql`${searchDocuments.publishedAt} >= ${input.publishedAfter.toISOString()}::timestamptz`);
  if (input.publishedBefore) filters.push(sql`${searchDocuments.publishedAt} <= ${input.publishedBefore.toISOString()}::timestamptz`);
  if (input.domains?.length) {
    const domains = input.domains.map((domain) => new URL(`https://${domain}`).hostname.toLowerCase());
    filters.push(sql`(${sql.join(domains.map((domain) => sql`${searchDocuments.canonicalUrl} like ${`%://${escapeLike(domain)}/%`} escape '\\'`), sql` or `)})`);
  }
  const where = sql.join(filters, sql` and `);
  const lexical = sql`
    select ${searchChunks.documentId} as document_id,
      row_number() over (order by max(ts_rank_cd(${searchChunks.searchVector}, websearch_to_tsquery('simple', ${input.query}))) + greatest(similarity(coalesce(${searchDocuments.title}, ''), ${input.query}), similarity(coalesce(${searchDocuments.description}, ''), ${input.query})) desc, ${searchChunks.documentId}) as rank
    from ${searchChunks} inner join ${searchDocuments} on ${searchDocuments.id} = ${searchChunks.documentId}
    where ${where} and (${searchChunks.searchVector} @@ websearch_to_tsquery('simple', ${input.query}) or coalesce(${searchDocuments.title}, '') % ${input.query} or coalesce(${searchDocuments.description}, '') % ${input.query})
    group by ${searchChunks.documentId}
    order by rank limit 100`;
  const semantic = embedding ? sql`
    select ${searchChunks.documentId} as document_id,
      row_number() over (order by min(${searchChunks.embedding} <=> ${JSON.stringify(embedding)}::vector) asc, ${searchChunks.documentId}) as rank
    from ${searchChunks} inner join ${searchDocuments} on ${searchDocuments.id} = ${searchChunks.documentId}
    where ${where} and ${searchChunks.embedding} is not null
    group by ${searchChunks.documentId}
    order by rank limit 100` : undefined;
  const statement = input.mode === 'hybrid' && semantic ? sql`
    with lexical as (${lexical}), semantic as (${semantic}), fused as (
      select coalesce(lexical.document_id, semantic.document_id) as document_id,
        coalesce(1.0 / (60 + lexical.rank), 0) + coalesce(1.0 / (60 + semantic.rank), 0) as score
      from lexical full outer join semantic on lexical.document_id = semantic.document_id
    ) select document_id as "documentId", score from fused order by score desc, document_id limit ${input.limit + 1} offset ${offset}` : input.mode === 'semantic' && semantic ? sql`
    with semantic as (${semantic}) select document_id as "documentId", 1.0 / (60 + rank) as score
    from semantic order by score desc, document_id limit ${input.limit + 1} offset ${offset}` : sql`
    with lexical as (${lexical}) select document_id as "documentId", 1.0 / (60 + rank) as score
    from lexical order by score desc, document_id limit ${input.limit + 1} offset ${offset}`;
  return getDb().execute<{ documentId: string; score: number }>(statement);
}

router.post('/index/urls', requireResourceScope('clarity:index'), async (req, res) => {
  const input = parse(urlsSchema, req, res);
  if (!input) return;
  const idempotencyKey = requireIdempotency(req, res);
  if (!idempotencyKey) return;
  const operation = await createIndexOperation(req, input.urls.map(canonicalizePublicUrl), idempotencyKey);
  if (!operation) { sendError(res, 429, 'active_crawl_quota_exceeded', 'The active crawl quota has been exhausted', req); return; }
  res.status(202).json(publicOperation(operation));
});

router.post('/resolve', requireResourceScope('clarity:index'), async (req, res) => {
  const input = parse(resolveSchema, req, res);
  if (!input) return;
  const urls = input.urls.map(canonicalizePublicUrl);
  const rows = await getDb().select().from(searchDocuments).where(inArray(searchDocuments.canonicalUrl, urls));
  const byUrl = new Map(rows.map((row) => [row.canonicalUrl, row]));
  const missing = urls.filter((url) => !byUrl.has(url));
  let operationId: string | undefined;
  if (missing.length) {
    const idempotencyKey = req.header('idempotency-key') || `resolve:${crypto.randomUUID()}`;
    const operation = await createIndexOperation(req, missing, idempotencyKey);
    if (!operation) { sendError(res, 429, 'active_crawl_quota_exceeded', 'The active crawl quota has been exhausted', req); return; }
    operationId = operation.id;
  }
  res.status(missing.length ? 202 : 200).json({ data: urls.map((url) => {
    const document = byUrl.get(url);
    return document ? { url, document: publicDocument(document), status: document.status } : { url, operationId, status: 'queued' };
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
  const site = await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${principal.accountId}:sites`}, 0))`);
    const [existing] = await tx.select().from(searchSites).where(and(eq(searchSites.ownerAccountId, principal.accountId), eq(searchSites.origin, origin))).limit(1);
    if (existing) return existing;
    const limit = await effectiveQuota(tx, principal.accountId, 'sites');
    const [current] = await tx.select({ quantity: sql<number>`count(*)::int` }).from(searchSites).where(and(eq(searchSites.ownerAccountId, principal.accountId), sql`${searchSites.status} <> 'removed'`));
    if (current.quantity >= limit) return undefined;
    const [created] = await tx.insert(searchSites).values({ id: crypto.randomUUID(), ownerAccountId: principal.accountId, origin, verifiedDomainId: input.verifiedDomainId, sitemapUrls: input.sitemapUrls, feedUrls: input.feedUrls }).returning();
    return created;
  });
  if (!site) { sendError(res, 429, 'site_quota_exceeded', 'The verified site quota has been exhausted', req); return; }
  res.status(201).json(publicSite(site));
});

router.post('/sites/:id/crawls', requireResourceScope('clarity:sites:manage'), async (req, res) => {
  const principal = req.resourcePrincipal;
  const idempotencyKey = requireIdempotency(req, res);
  if (!principal || !idempotencyKey) return;
  const [site] = await getDb().select().from(searchSites).where(and(eq(searchSites.id, String(req.params.id)), eq(searchSites.ownerAccountId, principal.accountId))).limit(1);
  if (!site) { sendError(res, 404, 'site_not_found', 'Site not found', req); return; }
  const operation = await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${principal.accountId}:active_crawls`}, 0))`);
    const [existing] = await tx.select().from(crawlJobs).where(and(eq(crawlJobs.ownerAccountId, principal.accountId), eq(crawlJobs.applicationId, principal.applicationId), eq(crawlJobs.idempotencyKey, idempotencyKey))).limit(1);
    if (existing) return existing;
    const limit = await effectiveQuota(tx, principal.accountId, 'active_crawls');
    const [current] = await tx.select({ quantity: sql<number>`count(*)::int` }).from(crawlJobs).where(and(eq(crawlJobs.ownerAccountId, principal.accountId), inArray(crawlJobs.status, ['queued', 'running'])));
    if (current.quantity >= limit) return undefined;
    const [created] = await tx.insert(crawlJobs).values({ id: crypto.randomUUID(), ownerAccountId: principal.accountId, applicationId: principal.applicationId, credentialId: principal.credentialId, siteId: site.id, kind: 'site', idempotencyKey, requestedUrls: [site.origin] }).returning();
    return created;
  });
  if (!operation) { sendError(res, 429, 'active_crawl_quota_exceeded', 'The active crawl quota has been exhausted', req); return; }
  res.status(202).json(publicOperation(operation));
});

// Asynchronous crawl/index work is an INDEX OPERATION. The `/v1/jobs` namespace
// belongs to the employment vertical below; the two must never overlap.
router.get('/operations/:id', requireResourceScope('clarity:index'), async (req, res) => {
  const principal = req.resourcePrincipal;
  if (!principal) return;
  const [operation] = await getDb().select().from(crawlJobs).where(and(eq(crawlJobs.id, String(req.params.id)), eq(crawlJobs.ownerAccountId, principal.accountId))).limit(1);
  if (!operation) { sendError(res, 404, 'operation_not_found', 'Index operation not found', req); return; }
  res.json(publicOperation(operation));
});

router.post('/operations/:id/cancel', requireResourceScope('clarity:index'), async (req, res) => {
  const principal = req.resourcePrincipal;
  if (!principal) return;
  const [operation] = await getDb().update(crawlJobs).set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(crawlJobs.id, String(req.params.id)), eq(crawlJobs.ownerAccountId, principal.accountId), inArray(crawlJobs.status, ['queued', 'running']))).returning();
  if (!operation) { sendError(res, 409, 'operation_not_cancellable', 'Index operation is missing or already terminal', req); return; }
  res.json(publicOperation(operation));
});

// ---------------------------------------------------------------------------
// Clarity Jobs — the employment vertical. `/v1/jobs` is jobs in the human
// sense; asynchronous crawl work lives under `/v1/operations`.
// ---------------------------------------------------------------------------

const ingestJobSchema = z.object({
  url: z.string().url(),
  /** `schema.org/JobPosting` JSON-LD, exactly as the publisher emits it. */
  jobPosting: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
  /** Set when the publisher has closed the listing. */
  closed: z.boolean().default(false),
});

router.post('/jobs/search', requireResourceScope('clarity:search'), async (req, res) => {
  const input = parse(jobSearchSchema, req, res);
  const principal = req.resourcePrincipal;
  if (!input || !principal) return;
  const usage = await consumeUsage({ principal, operation: 'search' });
  if (!usage.accepted) {
    sendError(res, 429, 'monthly_quota_exceeded', 'The monthly search quota has been exhausted', req, { metric: 'search_month', limit: usage.limit, used: usage.used });
    return;
  }
  try {
    res.json(await searchJobs(input));
  } catch (error) {
    sendJobsError(error, req, res);
  }
});

router.get('/jobs/capability', requireResourceScope('clarity:search'), (_req, res) => res.json(CLARITY_JOBS_CAPABILITY));

router.get('/jobs/stats', requireResourceScope('clarity:search'), async (_req, res) => res.json(await jobCorpusStats()));

router.get('/jobs/by-url', requireResourceScope('clarity:search'), async (req, res) => {
  if (typeof req.query.url !== 'string') { sendError(res, 400, 'invalid_request', 'url is required', req); return; }
  try {
    const job = await getJobPostingByUrl(req.query.url);
    if (!job) { sendError(res, 404, 'job_not_found', 'Job posting not found', req); return; }
    res.json(job);
  } catch (error) {
    sendJobsError(error, req, res);
  }
});

/** Abuse report. Recorded without a reporter identity and never used in rank. */
router.post('/jobs/:id/report', requireResourceScope('clarity:search'), async (req, res) => {
  const input = parse(jobReportSchema, req, res);
  if (!input) return;
  const accepted = await reportJobPosting(String(req.params.id), input);
  if (!accepted) { sendError(res, 404, 'job_not_found', 'Job posting not found', req); return; }
  res.status(202).json({ status: 'received' });
});

router.get('/jobs/:id', requireResourceScope('clarity:search'), async (req, res) => {
  const job = await getJobPostingById(String(req.params.id));
  if (!job) { sendError(res, 404, 'job_not_found', 'Job posting not found', req); return; }
  res.json(job);
});

/**
 * Publisher boundary. A first-party product (or an employer) hands Clarity a
 * listing it just published, updated or closed instead of waiting for a crawl.
 * A structured payload requires a verified site for the listing's host, so no
 * caller can inject a listing onto a domain it does not own; a bare URL is
 * simply an ordinary index request.
 */
router.post('/jobs/ingest', requireResourceScope('clarity:index'), async (req, res) => {
  const input = parse(ingestJobSchema, req, res);
  const principal = req.resourcePrincipal;
  if (!input || !principal) return;
  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizePublicUrl(input.url);
  } catch {
    sendError(res, 400, 'invalid_request', 'url must be a public HTTP(S) URL', req);
    return;
  }

  if (input.closed || input.jobPosting) {
    const site = await findVerifiedSite(principal.accountId, canonicalUrl);
    if (!site) {
      sendError(res, 403, 'site_not_verified', 'The listing host is not a verified Clarity site owned by this account', req);
      return;
    }
    if (input.closed) {
      const [document] = await getDb().select({ id: searchDocuments.id }).from(searchDocuments)
        .where(eq(searchDocuments.canonicalUrl, canonicalUrl)).limit(1);
      if (!document) { sendError(res, 404, 'job_not_found', 'Job posting not found', req); return; }
      await closeJobPostingsForDocument(getDb(), document.id, 'source_closed');
      res.json({ url: canonicalUrl, status: 'closed' });
      return;
    }
    let ingested: { jobPostingIds: string[] };
    try {
      ingested = await ingestJobPosting({
        canonicalUrl,
        structuredData: Array.isArray(input.jobPosting) ? input.jobPosting : [input.jobPosting],
        siteId: site.id,
        sourceType: 'first_party',
        submittedByApplicationId: principal.applicationId,
        observedAt: new Date(),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'no_job_posting') {
        sendError(res, 400, 'job_posting_invalid', 'jobPosting must contain a schema.org JobPosting with a title and hiringOrganization', req);
        return;
      }
      throw error;
    }
    // Confirm the public page against the payload; the source stays canonical.
    const operation = await createIndexOperation(req, [canonicalUrl], req.header('idempotency-key') || `job-ingest:${crypto.randomUUID()}`);
    const job = await getJobPostingById(ingested.jobPostingIds[0]);
    res.status(202).json({
      url: canonicalUrl,
      ...(job ? { job } : {}),
      ...(operation ? { operationId: operation.id } : {}),
      status: 'indexed',
    });
    return;
  }

  const operation = await createIndexOperation(req, [canonicalUrl], req.header('idempotency-key') || `job-ingest:${crypto.randomUUID()}`);
  if (!operation) { sendError(res, 429, 'active_crawl_quota_exceeded', 'The active crawl quota has been exhausted', req); return; }
  res.status(202).json({ url: canonicalUrl, operationId: operation.id, status: 'queued' });
});

async function findVerifiedSite(accountId: string, url: string) {
  const host = new URL(url).hostname.toLowerCase();
  const sites = await getDb().select().from(searchSites)
    .where(and(eq(searchSites.ownerAccountId, accountId), eq(searchSites.status, 'active')));
  return sites.find((site) => {
    const origin = new URL(site.origin).hostname.toLowerCase();
    return host === origin || host.endsWith(`.${origin}`);
  });
}

function sendJobsError(error: unknown, req: Request, res: Response): void {
  if (error instanceof JobsError) {
    sendError(res, error.status, error.code, error.message, req);
    return;
  }
  throw error;
}

// Registered public job feeds. Sources are data, not a hardcoded list, so
// adding a company's board is a row rather than a deploy. Every supported kind
// is a keyless public endpoint — no credential is stored or accepted here.
const registerJobFeedSchema = z.object({
  kind: z.enum(JOB_FEED_KINDS),
  identifier: z.string().trim().min(1).max(2_048),
  label: z.string().trim().max(200).optional(),
  pollIntervalSeconds: z.number().int().min(900).max(604_800).default(21_600),
});

router.get('/jobs/feeds', requireResourceScope('clarity:index'), async (_req, res) => {
  const rows = await getDb().select().from(jobFeeds).orderBy(jobFeeds.kind, jobFeeds.identifier).limit(500);
  res.json({ data: rows.map(publicJobFeed), identifierMeaning: JOB_FEED_IDENTIFIER_MEANING });
});

router.post('/jobs/feeds', requireResourceScope('clarity:index'), async (req, res) => {
  const input = parse(registerJobFeedSchema, req, res);
  if (!input) return;
  try {
    // Resolve now so a malformed identifier fails at registration rather than
    // silently fetching the wrong board on the next poll.
    jobFeedUrl(input.kind, input.identifier);
  } catch (error) {
    sendError(res, 400, 'invalid_request', error instanceof Error ? error.message : 'Invalid feed identifier', req);
    return;
  }
  const [row] = await getDb().insert(jobFeeds)
    .values({ id: crypto.randomUUID(), kind: input.kind, identifier: input.identifier, label: input.label, pollIntervalSeconds: input.pollIntervalSeconds })
    .onConflictDoUpdate({
      target: [jobFeeds.kind, jobFeeds.identifier],
      set: { label: input.label, pollIntervalSeconds: input.pollIntervalSeconds, enabled: true, updatedAt: new Date() },
    })
    .returning();
  res.status(201).json(publicJobFeed(row));
});

router.delete('/jobs/feeds/:id', requireResourceScope('clarity:index'), async (req, res) => {
  // Disabled, not deleted: the listings it already produced keep their
  // provenance, and re-registering the same source resumes rather than restarts.
  const [row] = await getDb().update(jobFeeds).set({ enabled: false, updatedAt: new Date() })
    .where(eq(jobFeeds.id, String(req.params.id))).returning();
  if (!row) { sendError(res, 404, 'job_feed_not_found', 'Job feed not found', req); return; }
  res.json(publicJobFeed(row));
});

router.get('/usage', requireResourceScope('clarity:usage:read'), async (req, res) => {
  const principal = req.resourcePrincipal;
  if (!principal) return;
  const data = await getDb().select().from(searchUsageRollups).where(eq(searchUsageRollups.ownerAccountId, principal.accountId)).orderBy(desc(searchUsageRollups.periodStart)).limit(100);
  res.json({ data });
});

router.get('/quotas', requireResourceScope('clarity:usage:read'), async (req, res) => {
  const principal = req.resourcePrincipal;
  if (!principal) return;
  const entries = await Promise.all((Object.keys(SANDBOX_QUOTAS) as QuotaMetric[]).map(async (metric) => [metric, await effectiveQuota(getDb(), principal.accountId, metric)] as const));
  const quota = Object.fromEntries(entries) as Record<QuotaMetric, number>;
  res.json({ searchesPerMonth: quota.search_month, fetchesPerMonth: quota.fetch_month, sites: quota.sites, activeCrawls: quota.active_crawls, pagesPerCrawl: quota.pages_per_crawl, requestsPerMinuteCredential: quota.requests_minute_credential, requestsPerMinuteApplication: quota.requests_minute_application, concurrentFetches: quota.concurrent_fetches });
});

export async function createIndexOperation(req: Request, urls: string[], idempotencyKey: string) {
  const principal = req.resourcePrincipal;
  if (!principal) throw new Error('Resource principal missing after authentication');
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${principal.accountId}:active_crawls`}, 0))`);
    const [existing] = await tx.select().from(crawlJobs).where(and(eq(crawlJobs.ownerAccountId, principal.accountId), eq(crawlJobs.applicationId, principal.applicationId), eq(crawlJobs.idempotencyKey, idempotencyKey))).limit(1);
    if (existing) return existing;
    const activeLimit = await effectiveQuota(tx, principal.accountId, 'active_crawls');
    const pagesLimit = await effectiveQuota(tx, principal.accountId, 'pages_per_crawl');
    const [current] = await tx.select({ quantity: sql<number>`count(*)::int` }).from(crawlJobs).where(and(eq(crawlJobs.ownerAccountId, principal.accountId), inArray(crawlJobs.status, ['queued', 'running'])));
    if (current.quantity >= activeLimit || urls.length > pagesLimit) return undefined;
    const [operation] = await tx.insert(crawlJobs).values({ id: crypto.randomUUID(), ownerAccountId: principal.accountId, applicationId: principal.applicationId, credentialId: principal.credentialId, kind: 'urls', idempotencyKey, requestedUrls: urls, pagesDiscovered: urls.length }).returning();
    await tx.insert(crawlPages).values(urls.map((url) => ({ id: crypto.randomUUID(), jobId: operation.id, url, discoverySource: 'api' }))).onConflictDoNothing();
    return operation;
  });
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

function publicDocument(row: typeof searchDocuments.$inferSelect) {
  return { id: row.id, canonicalUrl: row.canonicalUrl, requestedUrl: row.requestedUrl, title: row.title ?? undefined, description: row.description ?? undefined, content: row.mainContent ?? undefined, type: row.documentType, status: row.status, language: row.language ?? undefined, publisher: row.publisherName ?? undefined, authors: [], publishedAt: row.publishedAt?.toISOString(), modifiedAt: row.modifiedAt?.toISOString(), imageUrl: row.imageUrl ?? undefined, faviconUrl: row.faviconUrl ?? undefined, indexedAt: row.indexedAt?.toISOString(), evidence: row.fieldEvidence };
}
function publicOperation(row: typeof crawlJobs.$inferSelect) { return { id: row.id, kind: row.kind, status: row.status, pagesDiscovered: row.pagesDiscovered, pagesCompleted: row.pagesCompleted, ...(row.errorCode ? { error: { code: row.errorCode, detail: row.errorDetail ?? undefined } } : {}), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }; }
function publicJobFeed(row: typeof jobFeeds.$inferSelect) {
  return {
    id: row.id, kind: row.kind, identifier: row.identifier, label: row.label ?? undefined,
    enabled: row.enabled, pollIntervalSeconds: row.pollIntervalSeconds,
    lastPolledAt: row.lastPolledAt?.toISOString(), lastStatus: row.lastStatus ?? undefined,
    lastError: row.lastError ?? undefined, listingsSeen: row.listingsSeen,
  };
}
function publicSite(row: typeof searchSites.$inferSelect) { return { id: row.id, origin: row.origin, verifiedDomainId: row.verifiedDomainId, status: row.status, crawlEnabled: row.crawlEnabled, recrawlIntervalSeconds: row.recrawlIntervalSeconds, maxPagesPerCrawl: row.maxPagesPerCrawl, sitemapUrls: row.sitemapUrls, feedUrls: row.feedUrls, nextCrawlAt: row.nextCrawlAt?.toISOString() }; }
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
