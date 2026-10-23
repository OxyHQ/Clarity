import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { getDb, type ClarityTransaction } from '../../db/index.js';
import {
  crawlJobs,
  crawlPages,
  jobFeeds,
  searchDocuments,
  searchSites,
  searchUsageRollups,
} from '../../db/schema/index.js';
import {
  authenticateResource,
  requireResourceRequestRate,
  requireResourceScope,
  sendError,
  type ClarityResourcePrincipal,
} from '../../middleware/resource-auth.js';
import { getClarityServiceToken } from '../../lib/clarity-service-auth.js';
import {
  applicationLedgerKey,
  consumeUsage,
  effectiveQuota,
  SANDBOX_QUOTAS,
  type QuotaMetric,
} from '../../search/quotas.js';
import {
  findDocument,
  findDocumentByUrl,
  SearchError,
  searchIndex,
  searchSchema,
} from '../../search/document-search.js';
import {
  answeredToAny,
  iconHostsOf,
  publicDocument,
  type DocumentRow,
} from '../../search/public-document.js';
import { listNewsStories } from '../../search/news.js';
import { MAX_URL_LENGTH, publicUrlSchema } from '../../search/query-primitives.js';
import {
  JobsError,
  getJobPostingById,
  getJobPostingByUrl,
  jobCorpusStats,
  jobSearchSchema,
  searchJobs,
} from '../../search/jobs/service.js';
import { closeJobPostingsForDocument, ingestJobPosting } from '../../search/jobs/projection.js';
import { validateJobPostingPayload } from '../../search/jobs/ingest-validation.js';
import {
  createPlaceResolver,
  getPlace,
  placeSearchSchema,
  searchPlaces,
} from '../../search/places/repository.js';
import { jobReportSchema, reportJobPosting } from '../../search/jobs/reports.js';
import {
  getProduct,
  ProductCatalogError,
  productIdSchema,
  productSearchSchema,
  searchProducts,
} from '../../search/products/mercaria-catalog.js';
import type { ProductFeedKind } from '@clarity/shared-types';
import {
  getProductFeed,
  listProductFeedRecords,
  PRODUCT_FEED_RECORD_PAGE_MAX,
  ProductFeedError,
  registerProductFeed,
} from '../../search/products/feeds/feeds.js';
import { PRODUCT_FEED_KINDS } from '../../search/products/feeds/providers.js';
import { withPageText } from '../../search/page-text.js';
import {
  JOB_FEED_IDENTIFIER_MEANING,
  JOB_FEED_KINDS,
  assertJobFeedIdentifier,
  jobFeedMinPollIntervalSeconds,
} from '../../search/jobs/feeds/endpoints.js';

const router = Router();
router.use(authenticateResource);
router.use(requireResourceRequestRate);

const urlsSchema = z.object({ urls: z.array(publicUrlSchema).min(1).max(50) });
const resolveSchema = urlsSchema.extend({ waitMs: z.number().int().min(0).max(10_000).optional() });
const createSiteSchema = z.object({
  origin: z.string().url().max(MAX_URL_LENGTH),
  verifiedDomainId: z.string().min(1),
  sitemapUrls: z.array(z.string().url()).max(20).default([]),
  feedUrls: z.array(z.string().url()).max(20).default([]),
});

router.post('/search', requireResourceScope('clarity:search'), async (req, res) => {
  const input = parse(searchSchema, req, res);
  if (!input) return;
  const principal = req.resourcePrincipal;
  if (!principal) return;
  const usage = await consumeUsage({ principal, operation: 'search' });
  if (!usage.accepted) {
    sendError(
      res,
      429,
      'monthly_quota_exceeded',
      'The monthly search quota has been exhausted',
      req,
      { metric: 'search_month', limit: usage.limit, used: usage.used },
    );
    return;
  }
  try {
    res.json(await searchIndex(input));
  } catch (error) {
    if (error instanceof SearchError) {
      sendError(res, error.status, error.code, error.message, req);
      return;
    }
    throw error;
  }
});

router.post('/index/urls', requireResourceScope('clarity:index'), async (req, res) => {
  const input = parse(urlsSchema, req, res);
  if (!input) return;
  const idempotencyKey = requireIdempotency(req, res);
  if (!idempotencyKey) return;
  const operation = await createIndexOperation(req, input.urls, idempotencyKey);
  if (!operation) {
    sendError(
      res,
      429,
      'active_crawl_quota_exceeded',
      'The active crawl quota has been exhausted',
      req,
    );
    return;
  }
  res.status(202).json(publicOperation(operation));
});

/** How often a waiting resolve looks at its crawl. */
const RESOLVE_POLL_MS = 400;
const TERMINAL_OPERATIONS: ReadonlySet<string> = new Set([
  'succeeded',
  'partial',
  'failed',
  'cancelled',
]);

/**
 * Each requested URL's document, if Clarity has fetched it, by any URL it
 * answered to. A `discovered` document — known from a web search, never
 * fetched — does not count. Exported for its Postgres suite.
 */
export async function fetchedDocuments(urls: readonly string[]): Promise<Map<string, DocumentRow>> {
  const rows = await withPageText(
    getDb(),
    await getDb().select().from(searchDocuments).where(answeredToAny(urls)),
  );
  const byUrl = new Map<string, DocumentRow>();
  for (const url of urls) {
    const row = rows.find(
      (candidate) =>
        candidate.status !== 'discovered' &&
        (candidate.canonicalUrl === url ||
          candidate.requestedUrl === url ||
          candidate.finalUrl === url),
    );
    if (row) byUrl.set(url, row);
  }
  return byUrl;
}

router.post('/resolve', requireResourceScope('clarity:index'), async (req, res) => {
  const input = parse(resolveSchema, req, res);
  if (!input) return;
  const { urls } = input;
  let byUrl = await fetchedDocuments(urls);
  const missing = [...new Set(urls.filter((url) => !byUrl.has(url)))];
  // A caller that waits has a person waiting on the answer (a composer, a
  // freshly published post); one that does not is warming in the background.
  const operations = missing.length
    ? await resolveIndexOperations(
        req,
        missing,
        input.waitMs ? RESOLVE_WAITING_PRIORITY : RESOLVE_BACKGROUND_PRIORITY,
      )
    : new Map<string, typeof crawlJobs.$inferSelect>();
  if (missing.length && operations.size === 0 && byUrl.size === 0) {
    sendError(
      res,
      429,
      'active_crawl_quota_exceeded',
      'The active crawl quota has been exhausted',
      req,
    );
    return;
  }
  const statuses = new Map(
    [...operations.values()].map((operation) => [operation.id, operation.status]),
  );
  const deadline = Date.now() + (input.waitMs ?? 0);
  while (
    [...statuses.values()].some((status) => !TERMINAL_OPERATIONS.has(status)) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(RESOLVE_POLL_MS, deadline - Date.now())),
    );
    const current = await getDb()
      .select({ id: crawlJobs.id, status: crawlJobs.status })
      .from(crawlJobs)
      .where(inArray(crawlJobs.id, [...statuses.keys()]));
    for (const operation of current) statuses.set(operation.id, operation.status);
  }
  if (input.waitMs) byUrl = await fetchedDocuments(urls);
  const unfetchedStatus = (url: string) => {
    const operation = operations.get(url);
    if (!operation) return 'throttled';
    return !TERMINAL_OPERATIONS.has(statuses.get(operation.id) ?? operation.status)
      ? 'queued'
      : 'failed';
  };
  const pending = urls.some((url) => !byUrl.has(url) && unfetchedStatus(url) === 'queued');
  const icons = await iconHostsOf([...byUrl.values()]);
  res.status(pending ? 202 : 200).json({
    data: urls.map((url) => {
      const document = byUrl.get(url);
      return document
        ? { url, document: publicDocument(document, icons), status: document.status }
        : {
            url,
            operationId: operations.get(url)?.id,
            status: unfetchedStatus(url),
            ...(!operations.has(url)
              ? { error: { code: 'active_crawl_quota_exceeded', retryable: true } }
              : {}),
          };
    }),
  });
});

router.get('/documents/by-url', requireResourceScope('clarity:search'), async (req, res) => {
  if (typeof req.query.url !== 'string') {
    sendError(res, 400, 'invalid_request', 'url is required', req);
    return;
  }
  const url = publicUrlSchema.safeParse(req.query.url);
  if (!url.success) {
    sendError(res, 400, 'invalid_request', 'url must be a public HTTP(S) URL', req);
    return;
  }
  const document = await findDocumentByUrl(url.data);
  if (!document) {
    sendError(res, 404, 'document_not_found', 'Document not found', req);
    return;
  }
  res.json(document);
});

router.get('/documents/:id', requireResourceScope('clarity:search'), async (req, res) => {
  const document = await findDocument(String(req.params.id));
  if (!document) {
    sendError(res, 404, 'document_not_found', 'Document not found', req);
    return;
  }
  res.json(document);
});

router.get('/news', requireResourceScope('clarity:search'), async (req, res) => {
  res.json({ data: await listNewsStories(req.query) });
});

router.get('/sites', requireResourceScope('clarity:sites:manage'), async (req, res) => {
  const principal = req.resourcePrincipal;
  if (!principal) return;
  const rows = await getDb()
    .select()
    .from(searchSites)
    .where(eq(searchSites.ownerAccountId, principal.accountId))
    .orderBy(desc(searchSites.id))
    .limit(100);
  res.json({ data: rows.map(publicSite) });
});

router.post('/sites', requireResourceScope('clarity:sites:manage'), async (req, res) => {
  const input = parse(createSiteSchema, req, res);
  const principal = req.resourcePrincipal;
  const idempotencyKey = requireIdempotency(req, res);
  if (!input || !principal || !idempotencyKey) return;
  const origin = new URL(input.origin).origin;
  if (
    !(await verifyDomainOwnership(
      principal.accountId,
      input.verifiedDomainId,
      new URL(origin).hostname,
    ))
  ) {
    sendError(
      res,
      403,
      'domain_not_verified',
      'The origin is not a verified Oxy domain owned by this account',
      req,
    );
    return;
  }
  const site = await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${principal.accountId}:sites`}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(searchSites)
      .where(
        and(eq(searchSites.ownerAccountId, principal.accountId), eq(searchSites.origin, origin)),
      )
      .limit(1);
    if (existing) return existing;
    const limit = await effectiveQuota(tx, principal, 'sites');
    const [current] = await tx
      .select({ quantity: sql<number>`count(*)::int` })
      .from(searchSites)
      .where(
        and(
          eq(searchSites.ownerAccountId, principal.accountId),
          sql`${searchSites.status} <> 'removed'`,
        ),
      );
    if (current.quantity >= limit) return undefined;
    const [created] = await tx
      .insert(searchSites)
      .values({
        id: crypto.randomUUID(),
        ownerAccountId: principal.accountId,
        origin,
        verifiedDomainId: input.verifiedDomainId,
        sitemapUrls: input.sitemapUrls,
        feedUrls: input.feedUrls,
      })
      .returning();
    return created;
  });
  if (!site) {
    sendError(res, 429, 'site_quota_exceeded', 'The verified site quota has been exhausted', req);
    return;
  }
  res.status(201).json(publicSite(site));
});

router.post('/sites/:id/crawls', requireResourceScope('clarity:sites:manage'), async (req, res) => {
  const principal = req.resourcePrincipal;
  const idempotencyKey = requireIdempotency(req, res);
  if (!principal || !idempotencyKey) return;
  const [site] = await getDb()
    .select()
    .from(searchSites)
    .where(
      and(
        eq(searchSites.id, String(req.params.id)),
        eq(searchSites.ownerAccountId, principal.accountId),
      ),
    )
    .limit(1);
  if (!site) {
    sendError(res, 404, 'site_not_found', 'Site not found', req);
    return;
  }
  const operation = await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${principal.accountId}:active_crawls`}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(crawlJobs)
      .where(
        and(
          eq(crawlJobs.ownerAccountId, principal.accountId),
          eq(crawlJobs.applicationId, applicationLedgerKey(principal)),
          eq(crawlJobs.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) return existing;
    if (!(await withinActiveCrawlQuota(tx, principal))) return undefined;
    const [created] = await tx
      .insert(crawlJobs)
      .values({
        id: crypto.randomUUID(),
        ownerAccountId: principal.accountId,
        applicationId: applicationLedgerKey(principal),
        credentialId: 'credentialId' in principal ? principal.credentialId : undefined,
        siteId: site.id,
        kind: 'site',
        idempotencyKey,
        requestedUrls: [site.origin],
        callerAuthority: principal.authority,
        callerKind: principal.kind,
      })
      .returning();
    return created;
  });
  if (!operation) {
    sendError(
      res,
      429,
      'active_crawl_quota_exceeded',
      'The active crawl quota has been exhausted',
      req,
    );
    return;
  }
  res.status(202).json(publicOperation(operation));
});

// Asynchronous crawl/index work is an INDEX OPERATION. The `/v1/jobs` namespace
// belongs to the employment vertical below; the two must never overlap.
router.get('/operations/:id', requireResourceScope('clarity:index'), async (req, res) => {
  const principal = req.resourcePrincipal;
  if (!principal) return;
  const [operation] = await getDb()
    .select()
    .from(crawlJobs)
    .where(
      and(
        eq(crawlJobs.id, String(req.params.id)),
        eq(crawlJobs.ownerAccountId, principal.accountId),
      ),
    )
    .limit(1);
  if (!operation) {
    sendError(res, 404, 'operation_not_found', 'Index operation not found', req);
    return;
  }
  res.json(publicOperation(operation));
});

router.post('/operations/:id/cancel', requireResourceScope('clarity:index'), async (req, res) => {
  const principal = req.resourcePrincipal;
  if (!principal) return;
  const [operation] = await getDb()
    .update(crawlJobs)
    .set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(crawlJobs.id, String(req.params.id)),
        eq(crawlJobs.ownerAccountId, principal.accountId),
        inArray(crawlJobs.status, ['queued', 'running']),
      ),
    )
    .returning();
  if (!operation) {
    sendError(
      res,
      409,
      'operation_not_cancellable',
      'Index operation is missing or already terminal',
      req,
    );
    return;
  }
  res.json(publicOperation(operation));
});

// ---------------------------------------------------------------------------
// Clarity Jobs — the employment vertical. `/v1/jobs` is jobs in the human
// sense; asynchronous crawl work lives under `/v1/operations`.
// ---------------------------------------------------------------------------

const ingestJobSchema = z.object({
  url: publicUrlSchema,
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
    sendError(
      res,
      429,
      'monthly_quota_exceeded',
      'The monthly search quota has been exhausted',
      req,
      { metric: 'search_month', limit: usage.limit, used: usage.used },
    );
    return;
  }
  try {
    res.json(await searchJobs(input));
  } catch (error) {
    sendJobsError(error, req, res);
  }
});

router.get('/jobs/stats', requireResourceScope('clarity:search'), async (_req, res) =>
  res.json(await jobCorpusStats()),
);

router.get('/jobs/by-url', requireResourceScope('clarity:search'), async (req, res) => {
  if (typeof req.query.url !== 'string') {
    sendError(res, 400, 'invalid_request', 'url is required', req);
    return;
  }
  try {
    const job = await getJobPostingByUrl(req.query.url);
    if (!job) {
      sendError(res, 404, 'job_not_found', 'Job posting not found', req);
      return;
    }
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
  if (!accepted) {
    sendError(res, 404, 'job_not_found', 'Job posting not found', req);
    return;
  }
  res.status(202).json({ status: 'received' });
});

router.get('/jobs/:id', requireResourceScope('clarity:search'), async (req, res) => {
  const job = await getJobPostingById(String(req.params.id));
  if (!job) {
    sendError(res, 404, 'job_not_found', 'Job posting not found', req);
    return;
  }
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
  const canonicalUrl = input.url;

  if (input.closed || input.jobPosting) {
    const site = await findVerifiedSite(principal.accountId, canonicalUrl);
    if (!site) {
      sendError(
        res,
        403,
        'site_not_verified',
        'The listing host is not a verified Clarity site owned by this account',
        req,
      );
      return;
    }
    if (input.closed) {
      const [document] = await getDb()
        .select({ id: searchDocuments.id })
        .from(searchDocuments)
        .where(eq(searchDocuments.canonicalUrl, canonicalUrl))
        .limit(1);
      if (!document) {
        sendError(res, 404, 'job_not_found', 'Job posting not found', req);
        return;
      }
      await closeJobPostingsForDocument(getDb(), document.id, 'source_closed');
      res.json({ url: canonicalUrl, status: 'closed' });
      return;
    }
    const structuredData = Array.isArray(input.jobPosting) ? input.jobPosting : [input.jobPosting];
    // A publisher controls its payload, so the vocabularies are errors here —
    // crawled and feed listings get the same values dropped instead.
    const validation = await validateJobPostingPayload(structuredData, createPlaceResolver());
    if (validation.issues.length > 0) {
      sendError(
        res,
        400,
        'invalid_job_posting',
        'jobPosting does not meet the Clarity Jobs ingest contract',
        req,
        { issues: validation.issues },
      );
      return;
    }
    if (validation.placesUnavailable) {
      sendError(
        res,
        503,
        'places_unavailable',
        'The place gazetteer has not been imported; locations cannot be verified',
        req,
      );
      return;
    }
    let ingested: { jobPostingIds: string[] };
    try {
      ingested = await ingestJobPosting({
        canonicalUrl,
        structuredData,
        siteId: site.id,
        sourceType: 'first_party',
        submittedByApplicationId: principal.applicationId ?? undefined,
        observedAt: new Date(),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'no_job_posting') {
        sendError(
          res,
          400,
          'invalid_job_posting',
          'jobPosting must contain a schema.org JobPosting with a title and hiringOrganization',
          req,
          {
            issues: [
              {
                path: 'jobPosting',
                code: 'job_posting_required',
                message: 'jobPosting must contain a schema.org JobPosting',
              },
            ],
          },
        );
        return;
      }
      throw error;
    }
    // Confirm the public page against the payload; the source stays canonical.
    const operation = await createIndexOperation(
      req,
      [canonicalUrl],
      req.header('idempotency-key') || `job-ingest:${crypto.randomUUID()}`,
    );
    const job = await getJobPostingById(ingested.jobPostingIds[0]);
    res.status(202).json({
      url: canonicalUrl,
      ...(job ? { job } : {}),
      ...(operation ? { operationId: operation.id } : {}),
      status: 'indexed',
    });
    return;
  }

  const operation = await createIndexOperation(
    req,
    [canonicalUrl],
    req.header('idempotency-key') || `job-ingest:${crypto.randomUUID()}`,
  );
  if (!operation) {
    sendError(
      res,
      429,
      'active_crawl_quota_exceeded',
      'The active crawl quota has been exhausted',
      req,
    );
    return;
  }
  res.status(202).json({ url: canonicalUrl, operationId: operation.id, status: 'queued' });
});

// Product feeds — public shop catalogues Clarity crawls (`docs/product-feeds.mdx`).
// Registering one asks Clarity to crawl it, so it is `clarity:index`; reading
// what a feed holds is the consumer's pull of the documents it asked for.
// ---------------------------------------------------------------------------

const productFeedRegistrationSchema = z.object({
  kind: z.enum(PRODUCT_FEED_KINDS as [ProductFeedKind, ...ProductFeedKind[]]),
  identifier: z.string().trim().min(1).max(253),
  label: z.string().trim().min(1).max(200).optional(),
});

const productFeedRecordsQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(PRODUCT_FEED_RECORD_PAGE_MAX).optional(),
});

function sendProductFeedError(error: unknown, req: Request, res: Response): void {
  if (error instanceof ProductFeedError) {
    sendError(res, error.status, error.code, error.message, req);
    return;
  }
  throw error;
}

router.put('/product-feeds', requireResourceScope('clarity:index'), async (req, res) => {
  const input = parse(productFeedRegistrationSchema, req, res);
  if (!input) return;
  try {
    res.json(await registerProductFeed(input));
  } catch (error) {
    sendProductFeedError(error, req, res);
  }
});

router.get('/product-feeds/:id', requireResourceScope('clarity:index'), async (req, res) => {
  try {
    res.json(await getProductFeed(String(req.params.id)));
  } catch (error) {
    sendProductFeedError(error, req, res);
  }
});

router.get(
  '/product-feeds/:id/records',
  requireResourceScope('clarity:index'),
  async (req, res) => {
    const query = productFeedRecordsQuerySchema.safeParse(req.query);
    if (!query.success) {
      sendError(
        res,
        400,
        'invalid_request',
        'cursor must be a cursor this feed issued; limit 1–500',
        req,
      );
      return;
    }
    try {
      res.json(await listProductFeedRecords(String(req.params.id), query.data));
    } catch (error) {
      sendProductFeedError(error, req, res);
    }
  },
);

// Products — shopping search, answered by Mercaria (`search/products/`).
// A search counts against the monthly search quota like any other; the read of
// one product is a hydration and does not.
// ---------------------------------------------------------------------------

router.post('/products/search', requireResourceScope('clarity:search'), async (req, res) => {
  const input = parse(productSearchSchema, req, res);
  const principal = req.resourcePrincipal;
  if (!input || !principal) return;
  const usage = await consumeUsage({ principal, operation: 'search' });
  if (!usage.accepted) {
    sendError(
      res,
      429,
      'monthly_quota_exceeded',
      'The monthly search quota has been exhausted',
      req,
      { metric: 'search_month', limit: usage.limit, used: usage.used },
    );
    return;
  }
  try {
    res.json(await searchProducts(input));
  } catch (error) {
    sendProductsError(error, req, res);
  }
});

router.get('/products/:id', requireResourceScope('clarity:search'), async (req, res) => {
  const id = productIdSchema.safeParse(req.params.id);
  if (!id.success) {
    sendError(res, 404, 'not_found', 'No such product', req);
    return;
  }
  try {
    res.json(await getProduct(id.data));
  } catch (error) {
    sendProductsError(error, req, res);
  }
});

function sendProductsError(error: unknown, req: Request, res: Response): void {
  if (error instanceof ProductCatalogError) {
    sendError(res, error.status, error.code, error.message, req);
    return;
  }
  throw error;
}

// Places — the canonical gazetteer a publisher picks a job location from.
// Reference data only; nothing here writes.
router.get('/places/search', requireResourceScope('clarity:search'), async (req, res) => {
  const parsed = placeSearchSchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', 'Request validation failed', req, {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return;
  }
  res.json({ data: await searchPlaces(parsed.data) });
});

router.get('/places/:id', requireResourceScope('clarity:search'), async (req, res) => {
  const place = await getPlace(String(req.params.id));
  if (!place) {
    sendError(res, 404, 'place_not_found', 'Place not found', req);
    return;
  }
  res.json(place);
});

async function findVerifiedSite(accountId: string, url: string) {
  const host = new URL(url).hostname.toLowerCase();
  const sites = await getDb()
    .select()
    .from(searchSites)
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
  const rows = await getDb()
    .select()
    .from(jobFeeds)
    .orderBy(jobFeeds.kind, jobFeeds.identifier)
    .limit(500);
  res.json({ data: rows.map(publicJobFeed), identifierMeaning: JOB_FEED_IDENTIFIER_MEANING });
});

router.post('/jobs/feeds', requireResourceScope('clarity:index'), async (req, res) => {
  const input = parse(registerJobFeedSchema, req, res);
  if (!input) return;
  try {
    // Resolve now so a malformed identifier fails at registration rather than
    // silently fetching the wrong board on the next poll.
    assertJobFeedIdentifier(input.kind, input.identifier);
  } catch (error) {
    sendError(
      res,
      400,
      'invalid_request',
      error instanceof Error ? error.message : 'Invalid feed identifier',
      req,
    );
    return;
  }
  // A source whose published terms ask for fewer requests gets no more than that.
  const pollIntervalSeconds = Math.max(
    input.pollIntervalSeconds,
    jobFeedMinPollIntervalSeconds(input.kind),
  );
  const [row] = await getDb()
    .insert(jobFeeds)
    .values({
      id: crypto.randomUUID(),
      kind: input.kind,
      identifier: input.identifier,
      label: input.label,
      pollIntervalSeconds,
    })
    .onConflictDoUpdate({
      target: [jobFeeds.kind, jobFeeds.identifier],
      set: { label: input.label, pollIntervalSeconds, enabled: true, updatedAt: new Date() },
    })
    .returning();
  res.status(201).json(publicJobFeed(row));
});

router.delete('/jobs/feeds/:id', requireResourceScope('clarity:index'), async (req, res) => {
  // Disabled, not deleted: the listings it already produced keep their
  // provenance, and re-registering the same source resumes rather than restarts.
  const [row] = await getDb()
    .update(jobFeeds)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(jobFeeds.id, String(req.params.id)))
    .returning();
  if (!row) {
    sendError(res, 404, 'job_feed_not_found', 'Job feed not found', req);
    return;
  }
  res.json(publicJobFeed(row));
});

router.get('/usage', requireResourceScope('clarity:usage:read'), async (req, res) => {
  const principal = req.resourcePrincipal;
  if (!principal) return;
  const data = await getDb()
    .select()
    .from(searchUsageRollups)
    .where(eq(searchUsageRollups.ownerAccountId, principal.accountId))
    .orderBy(desc(searchUsageRollups.periodStart))
    .limit(100);
  res.json({ data });
});

router.get('/quotas', requireResourceScope('clarity:usage:read'), async (req, res) => {
  const principal = req.resourcePrincipal;
  if (!principal) return;
  // `null` is "no limit": JSON has no Infinity, and one of Oxy's own
  // applications has no monthly quota at all.
  const entries = await Promise.all(
    (Object.keys(SANDBOX_QUOTAS) as QuotaMetric[]).map(async (metric) => {
      const limit = await effectiveQuota(getDb(), principal, metric);
      return [metric, Number.isFinite(limit) ? limit : null] as const;
    }),
  );
  const quota = Object.fromEntries(entries) as Record<QuotaMetric, number | null>;
  res.json({
    searchesPerMonth: quota.search_month,
    fetchesPerMonth: quota.fetch_month,
    sites: quota.sites,
    activeCrawls: quota.active_crawls,
    pagesPerCrawl: quota.pages_per_crawl,
    requestsPerMinuteCredential: quota.requests_minute_credential,
    requestsPerMinuteApplication: quota.requests_minute_application,
    concurrentFetches: quota.concurrent_fetches,
  });
});

/**
 * Crawl priority by who is asking. The worker claims the highest first.
 *
 * - 0: bulk indexing (`/index/urls`, job confirmation) — nobody is reading yet.
 * - 1: a resolve that does not wait — an application warming previews for
 *   content it just stored (Mention resolves the links of every post it
 *   ingests, federated ones included).
 * - 2: a resolve that waits — a person is looking at the empty card.
 *
 * With only 0 and 1, background warming and waiting readers shared one FIFO
 * tier: on 2026-10-12 a waiting reader's URL queued behind ~91k background
 * resolves at ~2k pages an hour, so every wait ran to its deadline.
 */
export const RESOLVE_BACKGROUND_PRIORITY = 1;
export const RESOLVE_WAITING_PRIORITY = 2;

/** Reuse pending work by URL, including overlapping and reordered read batches. */
export async function resolveIndexOperations(
  req: Request,
  urls: string[],
  priority: number = RESOLVE_BACKGROUND_PRIORITY,
) {
  const principal = req.resourcePrincipal;
  if (!principal) throw new Error('Resource principal missing after authentication');
  return getDb().transaction(async (tx) => {
    // The same quota lock as explicit indexing serializes read-before-enqueue
    // across all API replicas. A fresh random request key alone cannot dedupe.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${principal.accountId}:active_crawls`}, 0))`,
    );
    const existing = await tx
      .selectDistinctOn([crawlPages.url], { url: crawlPages.url, operation: crawlJobs })
      .from(crawlPages)
      .innerJoin(crawlJobs, eq(crawlJobs.id, crawlPages.jobId))
      .where(
        and(
          inArray(crawlPages.url, urls),
          inArray(crawlPages.status, ['queued', 'retry', 'fetching']),
          eq(crawlJobs.ownerAccountId, principal.accountId),
          eq(crawlJobs.applicationId, applicationLedgerKey(principal)),
          eq(crawlJobs.kind, 'urls'),
          inArray(crawlJobs.status, ['queued', 'running']),
        ),
      )
      .orderBy(crawlPages.url, crawlJobs.createdAt, crawlJobs.id);
    const operations = new Map<string, typeof crawlJobs.$inferSelect>();
    for (const { url, operation } of existing)
      if (!operations.has(url)) operations.set(url, operation);
    const missing = [...new Set(urls)].filter((url) => !operations.has(url));
    if (missing.length) {
      // A resolve may reuse part of another request's work. Bind the supplied
      // key to the subset actually inserted, so a later retry with a different
      // missing subset cannot borrow an operation that never owned those URLs.
      const suppliedKey = req.header('idempotency-key');
      const key = suppliedKey
        ? `resolve:${createHash('sha256')
            .update(JSON.stringify([suppliedKey, [...missing].sort()]))
            .digest('hex')}`
        : `resolve:${crypto.randomUUID()}`;
      const operation = await insertIndexOperation(tx, req, missing, key);
      if (operation)
        for (const url of missing) {
          if (operation.requestedUrls.includes(url)) operations.set(url, operation);
        }
    }
    const live = [...operations].filter(
      ([, operation]) => !TERMINAL_OPERATIONS.has(operation.status),
    );
    if (live.length) {
      // Current readers should not wait behind historical bulk ingestion, and a
      // waiting reader not behind background warming (see the priorities above).
      // Only ever raised. Keep availableAt and attempts untouched: promotion
      // never bypasses backoff.
      await tx
        .update(crawlPages)
        .set({ priority })
        .where(
          and(
            inArray(crawlPages.status, ['queued', 'retry']),
            sql`${crawlPages.priority} < ${priority}`,
            or(
              ...live.map(([url, operation]) =>
                and(eq(crawlPages.jobId, operation.id), eq(crawlPages.url, url)),
              ),
            ),
          ),
        );
    }
    return operations;
  });
}

export async function createIndexOperation(req: Request, urls: string[], idempotencyKey: string) {
  const principal = req.resourcePrincipal;
  if (!principal) throw new Error('Resource principal missing after authentication');
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${principal.accountId}:active_crawls`}, 0))`,
    );
    return insertIndexOperation(tx, req, [...new Set(urls)], idempotencyKey);
  });
}

/**
 * Whether the account may start another crawl. Caller holds the account's
 * active-crawl quota lock. Oxy's own applications have no active-crawl quota,
 * so their queued and running operations are never counted: for the account
 * behind Oxy's resolve traffic that was ~185k rows (2026-10-15), read under
 * the lock every one of its resolves waits on.
 */
async function withinActiveCrawlQuota(
  tx: ClarityTransaction,
  principal: ClarityResourcePrincipal,
): Promise<boolean> {
  const limit = await effectiveQuota(tx, principal, 'active_crawls');
  if (!Number.isFinite(limit)) return true;
  const [current] = await tx
    .select({ quantity: sql<number>`count(*)::int` })
    .from(crawlJobs)
    .where(
      and(
        eq(crawlJobs.ownerAccountId, principal.accountId),
        inArray(crawlJobs.status, ['queued', 'running']),
      ),
    );
  return current.quantity < limit;
}

/** Caller holds the account's active-crawl quota lock. */
async function insertIndexOperation(
  tx: ClarityTransaction,
  req: Request,
  urls: string[],
  idempotencyKey: string,
) {
  const principal = req.resourcePrincipal;
  if (!principal) throw new Error('Resource principal missing after authentication');
  const [existing] = await tx
    .select()
    .from(crawlJobs)
    .where(
      and(
        eq(crawlJobs.ownerAccountId, principal.accountId),
        eq(crawlJobs.applicationId, applicationLedgerKey(principal)),
        eq(crawlJobs.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) return existing;
  const pagesLimit = await effectiveQuota(tx, principal, 'pages_per_crawl');
  if (urls.length > pagesLimit || !(await withinActiveCrawlQuota(tx, principal))) return undefined;
  const [operation] = await tx
    .insert(crawlJobs)
    .values({
      id: crypto.randomUUID(),
      ownerAccountId: principal.accountId,
      applicationId: applicationLedgerKey(principal),
      credentialId: 'credentialId' in principal ? principal.credentialId : undefined,
      kind: 'urls',
      idempotencyKey,
      requestedUrls: urls,
      pagesDiscovered: urls.length,
      callerAuthority: principal.authority,
      callerKind: principal.kind,
    })
    .returning();
  await tx
    .insert(crawlPages)
    .values(
      urls.map((url) => ({
        id: crypto.randomUUID(),
        jobId: operation.id,
        url,
        discoverySource: 'api',
      })),
    )
    .onConflictDoNothing();
  return operation;
}

function parse<T>(schema: z.ZodType<T>, req: Request, res: Response): T | undefined {
  const result = schema.safeParse(req.body);
  if (result.success) return result.data;
  sendError(res, 400, 'invalid_request', 'Request validation failed', req, {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
  return undefined;
}

function requireIdempotency(req: Request, res: Response): string | undefined {
  const value = req.header('idempotency-key');
  if (value && value.length <= 200) return value;
  sendError(
    res,
    400,
    'idempotency_key_required',
    'A valid Idempotency-Key header is required',
    req,
  );
  return undefined;
}

function publicOperation(row: typeof crawlJobs.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    pagesDiscovered: row.pagesDiscovered,
    pagesCompleted: row.pagesCompleted,
    ...(row.errorCode
      ? { error: { code: row.errorCode, detail: row.errorDetail ?? undefined } }
      : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
function publicJobFeed(row: typeof jobFeeds.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    identifier: row.identifier,
    label: row.label ?? undefined,
    enabled: row.enabled,
    pollIntervalSeconds: row.pollIntervalSeconds,
    lastPolledAt: row.lastPolledAt?.toISOString(),
    lastStatus: row.lastStatus ?? undefined,
    lastError: row.lastError ?? undefined,
    listingsSeen: row.listingsSeen,
    discoveredFromFeedId: row.discoveredFromFeedId ?? undefined,
  };
}
function publicSite(row: typeof searchSites.$inferSelect) {
  return {
    id: row.id,
    origin: row.origin,
    verifiedDomainId: row.verifiedDomainId,
    status: row.status,
    crawlEnabled: row.crawlEnabled,
    recrawlIntervalSeconds: row.recrawlIntervalSeconds,
    maxPagesPerCrawl: row.maxPagesPerCrawl,
    sitemapUrls: row.sitemapUrls,
    feedUrls: row.feedUrls,
    nextCrawlAt: row.nextCrawlAt?.toISOString(),
  };
}
async function verifyDomainOwnership(
  accountId: string,
  verifiedDomainId: string,
  originHost: string,
): Promise<boolean> {
  const serviceToken = await getClarityServiceToken();
  const response = await fetch(
    `${(process.env.OXY_API_URL || 'https://api.oxy.so').replace(/\/$/, '')}/auth/resources/domains/verify`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ accountId, verifiedDomainId, originHost }),
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) return false;
  const result = z.object({ verified: z.boolean() }).safeParse(await response.json());
  return result.success && result.data.verified;
}

export default router;
