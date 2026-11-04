#!/usr/bin/env bun
import { reconcileAccountEvents } from './lib/account-event-reconciliation.js';
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { startPlatformActivity } from './lib/platform-activity.js';
import { createLogger } from './lib/logger.js';
import { and, eq, gt, gte, inArray, isNotNull, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { safeFetch } from '@oxy.so/core/server';

import { closePostgres, connectPostgres, getDb, type ClarityExecutor } from './db/index.js';
import {
  crawlJobs,
  crawlPages,
  fetchAttempts,
  jobPostings,
  searchDocuments,
  searchDocumentUrls,
} from './db/schema/index.js';
import { type ExtractedDocument, extractDocument } from './search/extractor.js';
import { decodeBody } from './search/decode-body.js';
import { PageFetchError, isTransientFetchFailure } from './search/fetch-failure.js';
import { fileName, pdfTitle } from './search/pdf-metadata.js';
import { waybackDocument } from './search/wayback.js';
import { FEED_USER_AGENT } from './search/jobs/feeds/robots.js';
import {
  applyOembed,
  documentFromOembed,
  fetchOembed,
  registeredOembedUrl,
  wantsOembed,
} from './search/oembed.js';
import {
  chunkText,
  documentChunkState,
  queueChunkEmbeddings,
  queueEmbeddingBacklog,
  replaceDocumentChunks,
} from './search/chunking.js';
import { extractJobPostings } from './search/jobs/extract.js';
import { JOB_RECRAWL_INTERVAL_SECONDS, sweepJobLifecycle } from './search/jobs/lifecycle.js';
import {
  closeJobPostingsForDocument,
  projectJobPostings,
  pruneInactiveJobDocuments,
} from './search/jobs/projection.js';
import { pollDueJobFeeds } from './search/jobs/feeds/poll.js';
import { pollDueProductFeeds } from './search/products/feeds/feeds.js';
import { mainContentToStore } from './search/page-text.js';
import { answeredToAny, recordDocumentUrls } from './search/public-document.js';
import { storableUrl } from './search/query-primitives.js';
import { resourceUrl } from './search/resource-url.js';
import { consumeUsage, effectiveQuota } from './search/quotas.js';
import {
  classifiedCrawlAuthoritySql,
  hasClassifiedCrawlAuthority,
  type CrawlCallerKind,
} from './search/crawl-authority.js';
import { refreshDueIcons, registerHosts } from './search/site-icons.js';
import { sweepExpiredEffectReceipts } from './db/capability-receipt-repository.js';
import { sweepImageCache } from './search/image-cache.js';
import {
  drainReferenceOutbox,
  expireFileEvents,
  reconcileDueReferences,
  releaseIdleReferences,
} from './files/references.js';

const log = createLogger('worker');
const workerId = process.env.CLARITY_WORKER_ID || `worker:${process.pid}:${crypto.randomUUID()}`;
const leaseSeconds = 60;
const maxBodyBytes = 5 * 1024 * 1024;
const extractorVersion = 'readability-0.6.0';
/** How often stored job statuses are reconciled with the lifecycle policy. */
const jobMaintenanceIntervalMs = 15 * 60 * 1000;
/** Site icons: a small batch every half minute, on their own loop. */
const iconRefreshIntervalMs = 30 * 1000;
const iconRefreshBatchSize = 10;
/**
 * Clarity's file references owed to Oxy (files/references.ts): drained every
 * ten seconds, so a released image leaves Oxy's books promptly; the nightly
 * reconciliation is checked on the same beat and runs when its day has come.
 */
const oxyFilesIntervalMs = 10 * 1000;
const jobRecrawlBatchSize = 50;
/**
 * Pages one worker crawls at the same time. The page lease (`SKIP LOCKED`) and
 * the per-owner `concurrent_fetches` quota (8 for Oxy's own apps) already govern
 * parallel crawling; the loop used to take one page at a time, so a single slow
 * site (up to the 30 s deadline) held up every link behind it.
 */
const crawlConcurrency = Math.min(
  16,
  Math.max(1, Number.parseInt(process.env.CRAWL_CONCURRENCY ?? '', 10) || 8),
);

/** Reclaim crashed workers before counting concurrency. A stale claim never owns a write. */
export async function recoverExpiredLeases(): Promise<number> {
  return getDb().transaction(async (tx) => {
    const expired = await tx
      .select()
      .from(crawlPages)
      .where(
        and(
          eq(crawlPages.status, 'fetching'),
          lt(crawlPages.leaseExpiresAt, new Date()),
          sql`exists (select 1 from ${crawlJobs} where ${crawlJobs.id} = ${crawlPages.jobId} and ${classifiedCrawlAuthoritySql(crawlJobs.callerAuthority, crawlJobs.callerKind)})`,
        ),
      )
      .orderBy(crawlPages.jobId, crawlPages.id)
      .limit(100)
      .for('update', { skipLocked: true });
    for (const page of expired) {
      await tx
        .update(crawlPages)
        .set({
          status: page.attemptCount < 3 ? 'retry' : 'failed',
          availableAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          lastErrorCode: 'lease_expired',
          lastErrorDetail: 'The crawl worker stopped renewing its lease',
          updatedAt: new Date(),
        })
        .where(eq(crawlPages.id, page.id));
      await tx
        .update(fetchAttempts)
        .set({ status: 'failed', errorCode: 'lease_expired', finishedAt: new Date() })
        .where(and(eq(fetchAttempts.crawlPageId, page.id), eq(fetchAttempts.status, 'running')));
      await finishJobIfComplete(tx, page.jobId);
    }
    return expired.length;
  });
}

/** Lock and fence every result commit, including errors and removed documents. */
export async function ownsPageLease(
  tx: ClarityExecutor,
  page: typeof crawlPages.$inferSelect,
): Promise<boolean> {
  if (!page.leaseOwner) return false;
  const [owned] = await tx
    .select({ id: crawlPages.id })
    .from(crawlPages)
    .where(
      and(
        eq(crawlPages.id, page.id),
        eq(crawlPages.status, 'fetching'),
        eq(crawlPages.leaseOwner, page.leaseOwner),
        eq(crawlPages.attemptCount, page.attemptCount),
        gt(crawlPages.leaseExpiresAt, new Date()),
      ),
    )
    .for('update');
  return Boolean(owned);
}

export async function renewPageLease(page: typeof crawlPages.$inferSelect): Promise<void> {
  if (!page.leaseOwner) return;
  await getDb()
    .update(crawlPages)
    .set({
      leaseExpiresAt: sql`now() + interval '60 seconds'`,
      heartbeatAt: new Date(),
    })
    .where(
      and(
        eq(crawlPages.id, page.id),
        eq(crawlPages.status, 'fetching'),
        eq(crawlPages.leaseOwner, page.leaseOwner),
        eq(crawlPages.attemptCount, page.attemptCount),
        gt(crawlPages.leaseExpiresAt, new Date()),
      ),
    );
}

export async function leaseNextPage() {
  const recovered = await recoverExpiredLeases();
  if (recovered > 0) log.info({ count: recovered }, 'Recovered expired crawl leases');
  return getDb().transaction(async (tx) => {
    const saturatedOwners: string[] = [];
    while (true) {
      const [page] = await tx
        .select()
        .from(crawlPages)
        .where(
          and(
            or(eq(crawlPages.status, 'queued'), eq(crawlPages.status, 'retry')),
            lt(crawlPages.availableAt, new Date()),
            or(
              sql`${crawlPages.leaseExpiresAt} is null`,
              lt(crawlPages.leaseExpiresAt, new Date()),
            ),
            saturatedOwners.length
              ? sql`${crawlPages.jobId} in (select ${crawlJobs.id} from ${crawlJobs} where ${notInArray(crawlJobs.ownerAccountId, saturatedOwners)})`
              : undefined,
            sql`exists (select 1 from ${crawlJobs} where ${crawlJobs.id} = ${crawlPages.jobId} and ${crawlJobs.status} in ('queued', 'running') and ${classifiedCrawlAuthoritySql(crawlJobs.callerAuthority, crawlJobs.callerKind)})`,
            // NULLS LAST matches clarity_crawl_pages_claim_idx; a bare DESC means NULLS FIRST and
            // forces a sort of every claimable page on each claim.
          ),
        )
        .orderBy(
          sql`${crawlPages.priority} desc nulls last`,
          crawlPages.availableAt,
          crawlPages.createdAt,
          crawlPages.id,
        )
        .limit(1)
        .for('update', { skipLocked: true });
      if (!page) return undefined;
      const [job] = await tx
        .select({
          ownerAccountId: crawlJobs.ownerAccountId,
          callerAuthority: crawlJobs.callerAuthority,
        })
        .from(crawlJobs)
        .where(eq(crawlJobs.id, page.jobId))
        .limit(1);
      if (!job) throw new Error(`Crawl job ${page.jobId} does not exist`);
      const [lock] = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`${job.ownerAccountId}:concurrent_fetches`}, 0)) as locked`,
      );
      if (!lock.locked) {
        saturatedOwners.push(job.ownerAccountId);
        continue;
      }
      const concurrencyLimit = await effectiveQuota(
        tx,
        { accountId: job.ownerAccountId, authority: callerAuthorityOf(job) },
        'concurrent_fetches',
      );
      const [active] = await tx
        .select({ quantity: sql<number>`count(*)::int` })
        .from(crawlPages)
        .innerJoin(crawlJobs, eq(crawlPages.jobId, crawlJobs.id))
        .where(
          and(
            eq(crawlJobs.ownerAccountId, job.ownerAccountId),
            eq(crawlPages.status, 'fetching'),
            gt(crawlPages.leaseExpiresAt, new Date()),
          ),
        );
      if (active.quantity >= concurrencyLimit) {
        saturatedOwners.push(job.ownerAccountId);
        continue;
      }
      const [leased] = await tx
        .update(crawlPages)
        .set({
          status: 'fetching',
          leaseOwner: workerId,
          leaseExpiresAt: sql`now() + interval '${sql.raw(String(leaseSeconds))} seconds'`,
          heartbeatAt: new Date(),
          attemptCount: page.attemptCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(crawlPages.id, page.id))
        .returning();
      await tx
        .update(crawlJobs)
        .set({
          status: 'running',
          startedAt: sql`coalesce(${crawlJobs.startedAt}, now())`,
          updatedAt: new Date(),
        })
        .where(eq(crawlJobs.id, page.jobId));
      return leased;
    }
  });
}

export async function processPage(page: typeof crawlPages.$inferSelect): Promise<void> {
  const heartbeat = setInterval(
    () => {
      void renewPageLease(page).catch((error: unknown) => {
        log.error({ crawlPageId: page.id, err: error }, 'Crawl lease heartbeat failed');
      });
    },
    (leaseSeconds * 1000) / 3,
  );
  heartbeat.unref();
  try {
    await processLeasedPage(page);
  } finally {
    clearInterval(heartbeat);
  }
}

async function processLeasedPage(page: typeof crawlPages.$inferSelect): Promise<void> {
  const startedAt = Date.now();
  const attemptId = crypto.randomUUID();
  const [job] = await getDb().select().from(crawlJobs).where(eq(crawlJobs.id, page.jobId)).limit(1);
  if (!job) throw new Error(`Crawl job ${page.jobId} does not exist`);
  // A page supplied by an older worker must not bypass the rolling-deploy hold.
  if (!hasClassifiedCrawlAuthority(job)) return;
  const principal = {
    accountId: job.ownerAccountId,
    applicationId: job.applicationId,
    credentialId: job.credentialId ?? undefined,
    authority: callerAuthorityOf(job),
    kind: callerKindOf(job),
  };
  if (!(await getDb().transaction((tx) => ownsPageLease(tx, page)))) return;
  if (await completeIfAlreadyFetched(page, job)) return;
  const fetchUsage = await consumeUsage({
    principal,
    operation: 'fetch_started',
    idempotencyKey: `crawl-page:${page.id}:attempt:${page.attemptCount}`,
  });
  if (!fetchUsage.accepted) {
    await getDb().transaction(async (tx) => {
      if (!(await ownsPageLease(tx, page))) return;
      await tx
        .update(crawlPages)
        .set({
          status: 'failed',
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: 'fetch_quota_exceeded',
          lastErrorDetail: 'The monthly fetch quota has been exhausted',
          updatedAt: new Date(),
        })
        .where(eq(crawlPages.id, page.id));
      await tx
        .update(crawlJobs)
        .set({
          errorCode: 'fetch_quota_exceeded',
          errorDetail: 'The monthly fetch quota has been exhausted',
          updatedAt: new Date(),
        })
        .where(eq(crawlJobs.id, page.jobId));
      await finishJobIfComplete(tx, page.jobId);
    });
    return;
  }
  const started = await getDb().transaction(async (tx) => {
    if (!(await ownsPageLease(tx, page))) return false;
    await tx.insert(fetchAttempts).values({
      id: attemptId,
      crawlPageId: page.id,
      attempt: page.attemptCount,
      fetchMode: 'http',
      status: 'running',
    });
    return true;
  });
  if (!started) return;
  let fetched: FetchedPage | undefined;
  let failure: unknown;
  try {
    fetched = await fetchPage(page.url);
  } catch (error) {
    failure = error;
  }
  // A listing that answers 404/410 has been withdrawn by its source. Record
  // the removal instead of indexing the error page.
  if (fetched?.kind === 'gone') {
    try {
      await recordGoneDocument(page, fetched.finalUrl, fetched.httpStatus, attemptId, startedAt);
    } catch (error) {
      await recordFetchFailure(page, attemptId, startedAt, error);
    }
    return;
  }
  let source: DocumentSource | undefined;
  try {
    if (fetched?.kind === 'pdf') source = sourceFromPdf(fetched);
    else if (fetched) source = await sourceFromPage(fetched, page.url);
  } catch (error) {
    failure = error;
  }
  try {
    // A page Clarity could not read may still be described by its publisher's
    // oEmbed endpoint, else by the Internet Archive's copy of it.
    source ??= await fallbackSource(page.url, failure);
    if (!source) throw failure;
    await storeDocument(page, job, principal, attemptId, startedAt, source);
  } catch (error) {
    await recordFetchFailure(page, attemptId, startedAt, error);
  }
}

/** What a fetch returned: a page to extract, or the source's word that the URL is gone. */
type FetchedPage =
  | { kind: 'gone'; finalUrl: string; httpStatus: number }
  | {
      kind: 'page';
      finalUrl: string;
      httpStatus: number;
      headers: IncomingHttpHeaders;
      contentType: string;
      bytes: number;
      html: string;
    }
  | {
      kind: 'pdf';
      finalUrl: string;
      httpStatus: number;
      headers: IncomingHttpHeaders;
      contentType: string;
      bytes: number;
      body: Buffer;
    };

/** Fetches the page; throws a {@link PageFetchError} when the answer is neither HTML nor a PDF. */
async function fetchPage(url: string): Promise<FetchedPage> {
  const result = await safeFetch(url, {
    headers: { 'User-Agent': FEED_USER_AGENT, accept: 'text/html,application/xhtml+xml' },
    maxRedirects: 5,
    headersTimeoutMs: 15_000,
    signal: AbortSignal.timeout(30_000),
  });
  // A redirect can land on a URL too long to be a document's key.
  if (!storableUrl(result.finalUrl)) {
    result.response.destroy();
    throw new PageFetchError('url_too_long');
  }
  if (result.status === 404 || result.status === 410) {
    result.response.destroy();
    return { kind: 'gone', finalUrl: result.finalUrl, httpStatus: result.status };
  }
  if (result.status >= 400) {
    result.response.destroy();
    throw new PageFetchError(`http_status_${result.status}`, { httpStatus: result.status });
  }
  const contentType = header(result.headers['content-type']);
  const pdf = contentType?.includes('application/pdf') ?? false;
  if (!contentType || (!contentType.includes('text/html') && !pdf)) {
    result.response.destroy();
    throw new PageFetchError('unsupported_content_type');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of result.response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes + buffer.length > maxBodyBytes) {
      result.response.destroy();
      // A PDF's card needs only its metadata, which a partial read may hold.
      if (pdf) break;
      throw new PageFetchError('response_too_large');
    }
    bytes += buffer.length;
    chunks.push(buffer);
  }
  if (pdf)
    return {
      kind: 'pdf',
      finalUrl: result.finalUrl,
      httpStatus: result.status,
      headers: result.headers,
      contentType,
      bytes,
      body: Buffer.concat(chunks),
    };
  return {
    kind: 'page',
    finalUrl: result.finalUrl,
    httpStatus: result.status,
    headers: result.headers,
    contentType,
    bytes,
    html: decodeBody(Buffer.concat(chunks), contentType),
  };
}

/** What a document is written from: the fetch's facts and the extracted fields. */
interface DocumentSource {
  fetchMode: 'http' | 'oembed' | 'wayback';
  finalUrl: string;
  httpStatus: number | null;
  etag?: string;
  lastModified?: string;
  contentType: string;
  bytes: number;
  extracted: ExtractedDocument;
}

/**
 * The fetched page's document. When the page declares no title, description or
 * image for sharing, its oEmbed endpoint (the one it links, else the
 * registry's) completes them (search/oembed.ts).
 */
async function sourceFromPage(
  fetched: Extract<FetchedPage, { kind: 'page' }>,
  requestedUrl: string,
): Promise<DocumentSource> {
  let extracted = extractDocument(fetched.html, fetched.finalUrl);
  if (wantsOembed(extracted)) {
    // The page's own link first; a degraded page can link a broken one, so
    // the registry's endpoint is asked when it gives no answer.
    const endpoints = [
      extracted.oembedUrl,
      registeredOembedUrl(fetched.finalUrl) ?? registeredOembedUrl(requestedUrl),
    ].filter((endpoint, index, all): endpoint is string =>
      Boolean(endpoint && all.indexOf(endpoint) === index),
    );
    for (const endpoint of endpoints) {
      const oembed = await fetchOembed(endpoint);
      if (!oembed) continue;
      extracted = applyOembed(extracted, oembed, endpoint);
      break;
    }
  }
  // A page with no title from any source is not the page: a bot interstitial
  // or a script-only shell (Amazon serves one to most crawls). It is asked
  // again later instead of stored as an empty card.
  if (!extracted.title) throw new PageFetchError('untitled_page', { transient: true });
  return {
    fetchMode: 'http',
    finalUrl: fetched.finalUrl,
    httpStatus: fetched.httpStatus,
    etag: header(fetched.headers.etag),
    lastModified: header(fetched.headers['last-modified']),
    contentType: fetched.contentType,
    bytes: fetched.bytes,
    extracted,
  };
}

/** A linked PDF: its metadata's title, else its file name (search/pdf-metadata.ts). */
function sourceFromPdf(fetched: Extract<FetchedPage, { kind: 'pdf' }>): DocumentSource {
  const stated = pdfTitle(fetched.body);
  const title = stated ?? fileName(fetched.finalUrl);
  if (!title) throw new PageFetchError('untitled_page');
  const extractedAt = new Date().toISOString();
  return {
    fetchMode: 'http',
    finalUrl: fetched.finalUrl,
    httpStatus: fetched.httpStatus,
    etag: header(fetched.headers.etag),
    lastModified: header(fetched.headers['last-modified']),
    contentType: fetched.contentType,
    bytes: fetched.bytes,
    extracted: {
      title,
      authors: [],
      documentType: 'other',
      structuredData: [],
      evidence: { title: { source: stated ? 'pdf_metadata' : 'url', extractedAt } },
      noindex: false,
      nofollow: false,
    },
  };
}

/**
 * A document for a page Clarity could not read, from the registered provider's
 * oEmbed answer, else the Wayback Machine's snapshot (search/wayback.ts). Its
 * evidence names the source, and a later fetch of the page replaces it
 * (`/resolve` re-queues such documents once a day).
 */
async function fallbackSource(url: string, failure: unknown): Promise<DocumentSource | undefined> {
  // The page's own answer, kept for diagnosis; the fields came from elsewhere.
  const httpStatus = failure instanceof PageFetchError ? (failure.httpStatus ?? null) : null;
  const endpoint = registeredOembedUrl(url);
  const oembed = endpoint ? await fetchOembed(endpoint) : undefined;
  if (endpoint && oembed?.title)
    return {
      fetchMode: 'oembed',
      finalUrl: url,
      httpStatus,
      contentType: 'application/json+oembed',
      bytes: 0,
      extracted: documentFromOembed(oembed, endpoint, url),
    };
  const archived = await waybackDocument(url);
  if (!archived) return undefined;
  return {
    fetchMode: 'wayback',
    finalUrl: url,
    httpStatus,
    contentType: 'text/html',
    bytes: 0,
    extracted: archived,
  };
}

/**
 * Folds into `documentId` any other document stored under one of `urls`: a
 * link variant stored before its canonical was known, or a page that has since
 * redirected, is this document now. The URLs that answered to it move here and
 * it is deleted, so fetching converges duplicates without a batch repair. A
 * document a job listing stands on is left to the Jobs lifecycle, which keeps
 * every listing (search/jobs/dedupe.ts). Returns the URLs the folded documents
 * were requested and fetched at, for the caller to record.
 */
async function absorbSupersededDocuments(
  tx: ClarityExecutor,
  documentId: string,
  urls: readonly string[],
): Promise<string[]> {
  const superseded = await tx
    .select({
      id: searchDocuments.id,
      requestedUrl: searchDocuments.requestedUrl,
      finalUrl: searchDocuments.finalUrl,
    })
    .from(searchDocuments)
    .where(
      and(
        inArray(searchDocuments.canonicalUrl, [...urls]),
        ne(searchDocuments.id, documentId),
        sql`not exists (select 1 from ${jobPostings} where ${jobPostings.documentId} = ${searchDocuments.id})`,
      ),
    );
  if (superseded.length === 0) return [];
  const ids = superseded.map((row) => row.id);
  await tx
    .update(searchDocumentUrls)
    .set({ documentId, updatedAt: new Date() })
    .where(inArray(searchDocumentUrls.documentId, ids));
  await tx.delete(searchDocuments).where(inArray(searchDocuments.id, ids));
  return superseded.flatMap((row) =>
    row.finalUrl ? [row.requestedUrl, row.finalUrl] : [row.requestedUrl],
  );
}

async function storeDocument(
  page: typeof crawlPages.$inferSelect,
  job: typeof crawlJobs.$inferSelect,
  principal: Parameters<typeof consumeUsage>[0]['principal'],
  attemptId: string,
  startedAt: number,
  source: DocumentSource,
): Promise<void> {
  const { extracted } = source;
  // What the page declares, else the resource's own URL (search/resource-url.ts):
  // a link with a tracking parameter or a video's start time is the same document.
  const canonicalUrl = extracted.canonicalUrl || resourceUrl(source.finalUrl);
  const contentHash = createHash('sha256')
    .update(extracted.mainContent || '')
    .digest('hex');
  const textChunks = extracted.noindex ? [] : chunkText(extracted.mainContent || '');
  const observedAt = new Date();
  const postings = extracted.noindex
    ? []
    : extractJobPostings(
        extracted.structuredData,
        canonicalUrl,
        observedAt.toISOString(),
        'json_ld',
      );
  // A recrawl usually finds the page unchanged; its chunks are then kept as
  // they are rather than deleted and re-inserted on every fetch.
  const chunkState = await documentChunkState(
    getDb(),
    canonicalUrl,
    extracted.mainContent || '',
    textChunks.length,
    extractorVersion,
  );
  const documentId = await getDb().transaction(async (tx) => {
    if (!(await ownsPageLease(tx, page))) return undefined;
    const documentStatus = extracted.noindex ? 'blocked' : 'indexed';
    const nextFetchAt =
      postings.length > 0
        ? new Date(observedAt.getTime() + JOB_RECRAWL_INTERVAL_SECONDS * 1000)
        : null;
    const mutable = {
      siteId: job.siteId,
      finalUrl: source.finalUrl,
      status: documentStatus,
      documentType: extracted.documentType,
      contentHash,
      httpStatus: source.httpStatus,
      etag: source.etag,
      lastModified: source.lastModified,
      contentType: source.contentType,
      language: extracted.language,
      title: extracted.title,
      description: extracted.description,
      // The text is its chunks' unless they cannot give it back, and raw
      // JSON-LD is kept only for news, whose list falls back to it for a
      // date or publisher (search/page-text.ts, docs/search-storage.md).
      // What else a page states is already a column: publisher, dates,
      // authors, and a job posting's projection.
      mainContent: mainContentToStore(extracted.mainContent, textChunks),
      structuredData: extracted.documentType === 'news' ? extracted.structuredData : [],
      fieldEvidence: extracted.evidence,
      imageUrl: extracted.imageUrl,
      faviconUrl: extracted.faviconUrl,
      noindex: extracted.noindex,
      nofollow: extracted.nofollow,
      publishedAt: extracted.publishedAt,
      modifiedAt: extracted.modifiedAt,
      publisherName: extracted.publisher,
      authors: extracted.authors,
      fetchedAt: observedAt,
      indexedAt: extracted.noindex ? undefined : observedAt,
      nextFetchAt,
    };
    const [document] = await tx
      .insert(searchDocuments)
      .values({ id: crypto.randomUUID(), requestedUrl: page.url, canonicalUrl, ...mutable })
      .onConflictDoUpdate({
        target: searchDocuments.canonicalUrl,
        set: { ...mutable, updatedAt: observedAt },
      })
      .returning({ id: searchDocuments.id });
    // Every URL that reached this document finds it again (answeredToAny),
    // including those of a document it supersedes.
    const superseded = await absorbSupersededDocuments(tx, document.id, [
      page.url,
      source.finalUrl,
    ]);
    await recordDocumentUrls(tx, document.id, [
      page.url,
      source.finalUrl,
      canonicalUrl,
      ...superseded,
    ]);
    if (chunkState === 'stale')
      await replaceDocumentChunks(tx, document.id, textChunks, undefined, extractorVersion);
    await registerHosts(tx, [{ url: canonicalUrl, iconHintUrl: extracted.faviconUrl }]);
    await projectJobPostings(tx, {
      documentId: document.id,
      documentStatus,
      postings,
      sourceType: job.siteId ? 'verified_site' : 'web',
      observedAt,
    });
    await tx
      .update(crawlPages)
      .set({ status: 'succeeded', leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
      .where(eq(crawlPages.id, page.id));
    await tx
      .update(crawlJobs)
      .set({ pagesCompleted: sql`${crawlJobs.pagesCompleted} + 1`, updatedAt: new Date() })
      .where(eq(crawlJobs.id, page.jobId));
    await tx
      .update(fetchAttempts)
      .set({
        fetchMode: source.fetchMode,
        status: 'succeeded',
        httpStatus: source.httpStatus,
        bytesReceived: source.bytes,
        durationMs: Date.now() - startedAt,
        finishedAt: new Date(),
      })
      .where(eq(fetchAttempts.id, attemptId));
    await finishJobIfComplete(tx, page.jobId);
    return document.id;
  });
  if (documentId !== undefined && chunkState !== 'current') await queueChunkEmbeddings(documentId);
  if (documentId !== undefined && !extracted.noindex)
    await consumeUsage({
      principal,
      operation: 'page_indexed',
      idempotencyKey: `crawl-page:${page.id}:indexed`,
    });
}

/**
 * A fetch that ended without a document. A transient failure (search/fetch-failure.ts)
 * is retried with backoff and reads as retryable (`fetch_unavailable`); the
 * site's own refusal fails at once (`fetch_failed`).
 */
async function recordFetchFailure(
  page: typeof crawlPages.$inferSelect,
  attemptId: string,
  startedAt: number,
  error: unknown,
): Promise<void> {
  const transient = isTransientFetchFailure(error);
  const retry = transient && page.attemptCount < 3;
  const code = transient ? 'fetch_unavailable' : 'fetch_failed';
  const detail = error instanceof Error ? error.message.slice(0, 500) : 'unknown fetch failure';
  await getDb().transaction(async (tx) => {
    if (!(await ownsPageLease(tx, page))) return;
    await tx
      .update(crawlPages)
      .set({
        status: retry ? 'retry' : 'failed',
        availableAt: sql`now() + (${2 ** page.attemptCount} * interval '1 minute')`,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: code,
        lastErrorDetail: detail,
        updatedAt: new Date(),
      })
      .where(eq(crawlPages.id, page.id));
    await tx
      .update(fetchAttempts)
      .set({
        status: 'failed',
        httpStatus: error instanceof PageFetchError ? error.httpStatus : undefined,
        durationMs: Date.now() - startedAt,
        errorCode: code,
        errorDetail: detail,
        finishedAt: new Date(),
      })
      .where(eq(fetchAttempts.id, attemptId));
    if (!retry) await finishJobIfComplete(tx, page.jobId);
  });
}

/** The source withdrew this URL: remove the document and close its listings. */
async function recordGoneDocument(
  page: typeof crawlPages.$inferSelect,
  finalUrl: string,
  status: number,
  attemptId: string,
  startedAt: number,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    if (!(await ownsPageLease(tx, page))) return;
    const [document] = await tx
      .update(searchDocuments)
      .set({
        status: 'removed',
        httpStatus: status,
        finalUrl,
        fetchedAt: new Date(),
        nextFetchAt: null,
        updatedAt: new Date(),
      })
      .where(
        or(eq(searchDocuments.requestedUrl, page.url), eq(searchDocuments.canonicalUrl, page.url)),
      )
      .returning({ id: searchDocuments.id });
    if (document) await closeJobPostingsForDocument(tx, document.id, 'http_gone');
    await tx
      .update(crawlPages)
      .set({
        status: 'succeeded',
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: 'http_gone',
        updatedAt: new Date(),
      })
      .where(eq(crawlPages.id, page.id));
    await tx
      .update(crawlJobs)
      .set({ pagesCompleted: sql`${crawlJobs.pagesCompleted} + 1`, updatedAt: new Date() })
      .where(eq(crawlJobs.id, page.jobId));
    await tx
      .update(fetchAttempts)
      .set({
        status: 'succeeded',
        httpStatus: status,
        durationMs: Date.now() - startedAt,
        finishedAt: new Date(),
      })
      .where(eq(fetchAttempts.id, attemptId));
    await finishJobIfComplete(tx, page.jobId);
  });
}

/**
 * Finish a `/resolve` page whose URL was fetched AFTER it was requested, without
 * fetching it again.
 *
 * A resolve only queues URLs Clarity had no document for, but a page can sit in
 * the queue long enough for the same URL to be fetched through another request;
 * on 2026-10-12 most of the oldest resolve backlog pointed at URLs already
 * indexed. Fetching them again cost a fetch, the extraction and the embeddings
 * for a document the reader can already get. Only a document newer than the
 * request counts, so the reader never gets anything older than what they asked
 * after. Explicit indexing (`/index/urls`) and recrawls still always fetch.
 */
async function completeIfAlreadyFetched(
  page: typeof crawlPages.$inferSelect,
  job: typeof crawlJobs.$inferSelect,
): Promise<boolean> {
  if (job.kind !== 'urls' || !job.idempotencyKey?.startsWith('resolve:')) return false;
  return getDb().transaction(async (tx) => {
    if (!(await ownsPageLease(tx, page))) return true;
    const [document] = await tx
      .select({ id: searchDocuments.id })
      .from(searchDocuments)
      .where(
        and(
          answeredToAny([page.url]),
          ne(searchDocuments.status, 'discovered'),
          isNotNull(searchDocuments.title),
          gte(searchDocuments.fetchedAt, page.createdAt),
        ),
      )
      .limit(1);
    if (!document) return false;
    await tx
      .update(crawlPages)
      .set({ status: 'succeeded', leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
      .where(eq(crawlPages.id, page.id));
    await tx
      .update(crawlJobs)
      .set({ pagesCompleted: sql`${crawlJobs.pagesCompleted} + 1`, updatedAt: new Date() })
      .where(eq(crawlJobs.id, page.jobId));
    await finishJobIfComplete(tx, page.jobId);
    return true;
  });
}

async function finishJobIfComplete(
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  jobId: string,
) {
  // One pass over the job's pages for both counts: this runs after every page.
  const [{ pending, failed }] = await tx
    .select({
      pending: sql<number>`count(*) filter (where ${crawlPages.status} not in ('succeeded', 'failed'))::int`,
      failed: sql<number>`count(*) filter (where ${crawlPages.status} = 'failed')::int`,
    })
    .from(crawlPages)
    .where(eq(crawlPages.jobId, jobId));
  if (pending === 0) {
    await tx
      .update(crawlJobs)
      .set({
        status: failed > 0 ? 'partial' : 'succeeded',
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(crawlJobs.id, jobId));
  }
}

/**
 * Re-queues job documents that are due for verification, under the same owner
 * that originally requested them, so a listing's disappearance is noticed.
 *
 * The longest-overdue first, read from `clarity_search_documents_job_recrawl_due_idx`
 * (migration 0033). Without the order the planner chose a sequential scan of the
 * whole documents table whenever many listings were due, and walked it until it
 * had a batch: one scan per maintenance pass, up to 32 s (production, 2026-10-17).
 */
interface DueJobDocument extends Record<string, unknown> {
  documentId: string;
  url: string;
  ownerAccountId: string;
  applicationId: string;
  credentialId: string | null;
  siteId: string | null;
  callerAuthority: string;
  callerKind: string;
}

export async function enqueueJobRecrawls(): Promise<number> {
  const due = await getDb().execute<DueJobDocument>(sql`
    select ${searchDocuments.id} as "documentId", ${searchDocuments.canonicalUrl} as url,
      origin.owner_account_id as "ownerAccountId", origin.application_id as "applicationId",
      origin.credential_id as "credentialId", origin.site_id as "siteId", origin.caller_authority as "callerAuthority", origin.caller_kind as "callerKind"
    from ${searchDocuments}
    join lateral (
      select ${crawlJobs.ownerAccountId} as owner_account_id, ${crawlJobs.applicationId} as application_id,
        ${crawlJobs.credentialId} as credential_id, ${crawlJobs.siteId} as site_id,
        ${crawlJobs.callerAuthority} as caller_authority, ${crawlJobs.callerKind} as caller_kind
      from ${crawlPages} join ${crawlJobs} on ${crawlJobs.id} = ${crawlPages.jobId}
      where ${crawlPages.url} = ${searchDocuments.requestedUrl}
      order by ${crawlPages.createdAt} desc limit 1
    ) as origin on true
    where ${searchDocuments.documentType} = 'job'
      and ${searchDocuments.status} = 'indexed'
      and ${searchDocuments.nextFetchAt} is not null
      and ${searchDocuments.nextFetchAt} <= now()
      and ${classifiedCrawlAuthoritySql(sql`origin.caller_authority`, sql`origin.caller_kind`)}
    order by ${searchDocuments.nextFetchAt}
    limit ${jobRecrawlBatchSize}`);
  if (due.length === 0) return 0;

  const batches = new Map<string, DueJobDocument[]>();
  for (const row of due) {
    const key = JSON.stringify([
      row.ownerAccountId,
      row.applicationId,
      row.credentialId,
      row.siteId,
      row.callerAuthority,
      row.callerKind,
    ]);
    batches.set(key, [...(batches.get(key) ?? []), row]);
  }
  const cycle = new Date(Date.now() + JOB_RECRAWL_INTERVAL_SECONDS * 1000);
  await getDb().transaction(async (tx) => {
    for (const rows of batches.values()) {
      const [first] = rows;
      const urls = [...new Set(rows.map((row) => row.url))];
      const [operation] = await tx
        .insert(crawlJobs)
        .values({
          id: crypto.randomUUID(),
          ownerAccountId: first.ownerAccountId,
          applicationId: first.applicationId,
          credentialId: first.credentialId,
          siteId: first.siteId,
          kind: 'recrawl',
          idempotencyKey: `job-recrawl:${new Date().toISOString()}:${crypto.randomUUID()}`,
          requestedUrls: urls,
          pagesDiscovered: urls.length,
          callerAuthority: callerAuthorityOf(first),
          callerKind: callerKindOf(first),
        })
        .returning();
      await tx
        .insert(crawlPages)
        .values(
          urls.map((url) => ({
            id: crypto.randomUUID(),
            jobId: operation.id,
            url,
            discoverySource: 'recrawl',
          })),
        )
        .onConflictDoNothing();
    }
    await tx
      .update(searchDocuments)
      .set({ nextFetchAt: cycle, updatedAt: new Date() })
      .where(
        sql`${searchDocuments.id} in (${sql.join(
          due.map((row) => sql`${row.documentId}`),
          sql`, `,
        )})`,
      );
  });
  return due.length;
}

/**
 * Site icons are fetched beside the crawl loop, not inside it: a batch is up
 * to three fetches per host with their own timeouts, and inline it held every
 * page crawl (and a resolve caller waiting on one) behind it.
 */
async function runIconRefreshLoop(isStopping: () => boolean): Promise<void> {
  while (!isStopping()) {
    try {
      const { fetched, missing } = await refreshDueIcons(iconRefreshBatchSize);
      if (fetched + missing > 0) log.debug({ fetched, missing }, 'Site icons refreshed');
    } catch (error) {
      log.error({ err: error }, 'Site icon refresh failed');
    }
    for (let waited = 0; waited < iconRefreshIntervalMs && !isStopping(); waited += 1000) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/** Send owed reference changes to Oxy, and reconcile an entity type whose turn it is. */
async function runOxyFiles(): Promise<void> {
  try {
    const { sent, failed } = await drainReferenceOutbox();
    if (sent > 0 || failed) log.debug({ sent, failed }, 'Oxy file references sent');
  } catch (error) {
    log.error({ err: error }, 'Oxy file reference drain failed');
  }
  try {
    const reconciled = await reconcileDueReferences();
    if (Object.keys(reconciled).length > 0) log.info(reconciled, 'Oxy file references reconciled');
  } catch (error) {
    log.error({ err: error }, 'Oxy file reconciliation failed');
  }
}

/**
 * Release the images nobody has been shown in 30 days (Oxy collects them,
 * ADR 0043 D5) and forget what the cache no longer needs (search/image-cache.ts).
 */
async function runImageCacheSweep(): Promise<void> {
  try {
    const released = await releaseIdleReferences();
    const removed = await sweepImageCache();
    const events = await expireFileEvents();
    if (released + removed + events > 0)
      log.info({ released, removed, events }, 'Image uses released and cache swept');
  } catch (error) {
    log.error({ err: error }, 'Image cache sweep failed');
  }
}

/** Delete capability effect receipts past their retention (capabilities/effect-receipts.ts). */
async function runEffectReceiptSweep(): Promise<void> {
  try {
    const removed = await sweepExpiredEffectReceipts();
    if (removed > 0) log.info({ removed }, 'Capability effect receipts swept');
  } catch (error) {
    log.error({ err: error }, 'Capability effect receipt sweep failed');
  }
}

async function runJobMaintenance(): Promise<void> {
  try {
    const sweep = await sweepJobLifecycle();
    const recrawls = await enqueueJobRecrawls();
    const pruned = await pruneInactiveJobDocuments();
    log.info({ ...sweep, recrawls, pruned }, 'Job corpus maintenance completed');
  } catch (error) {
    log.error({ err: error }, 'Job corpus maintenance failed');
  }
}

/** How often the embedding backlog sweep tops the queue up (chunking.ts `queueEmbeddingBacklog`). */
const embeddingBacklogIntervalMs = 60 * 1000;

/**
 * Embeds the chunks still owed a vector at a steady pace — one batch a minute,
 * only while the queue is idle — so a backlog never rides on documents being
 * indexed again.
 */
async function runEmbeddingBacklogLoop(isStopping: () => boolean): Promise<void> {
  while (!isStopping()) {
    try {
      const queued = await queueEmbeddingBacklog();
      if (queued > 0) log.debug({ queued }, 'Embedding backlog queued');
    } catch (error) {
      log.error({ err: error }, 'Embedding backlog sweep failed');
    }
    for (let waited = 0; waited < embeddingBacklogIntervalMs && !isStopping(); waited += 1000) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/** How long the feed loop rests when no feed is due. */
const feedIdleMs = 30 * 1000;

/**
 * The supply side runs beside the crawl loop rather than inside the
 * maintenance pass, so a long feed walk never holds up page crawling and
 * feeds are polled as soon as they fall due. Feeds are claimed under SKIP
 * LOCKED, so several workers share them without polling one twice.
 */
async function runFeedLoop(isStopping: () => boolean): Promise<void> {
  while (!isStopping()) {
    let idle = true;
    try {
      const feeds = await pollDueJobFeeds();
      idle = feeds.polled + feeds.failed === 0;
      if (!idle) log.info(feeds, 'Job feeds polled');
    } catch (error) {
      log.error({ err: error }, 'Job feed polling failed');
    }
    // Rest in short steps so a shutdown is not held up by an idle wait.
    for (let waited = 0; idle && waited < feedIdleMs && !isStopping(); waited += 1000) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/**
 * Product feeds walk whole shop catalogues at a polite pace — minutes for a
 * large store or a Steam market — so they get a loop of their own and never
 * hold up job feeds. Claimed under SKIP LOCKED like job feeds.
 */
async function runProductFeedLoop(isStopping: () => boolean): Promise<void> {
  while (!isStopping()) {
    let idle = true;
    try {
      const feeds = await pollDueProductFeeds();
      idle = feeds.polled + feeds.failed === 0;
      if (!idle) log.info(feeds, 'Product feeds polled');
    } catch (error) {
      log.error({ err: error }, 'Product feed polling failed');
    }
    for (let waited = 0; idle && waited < feedIdleMs && !isStopping(); waited += 1000) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The side of the ecosystem the job's caller is on; anything unexpected is external. */
function callerAuthorityOf(job: { callerAuthority: string }): 'first_party' | 'external' {
  return job.callerAuthority === 'first_party' ? 'first_party' : 'external';
}

function callerKindOf(job: { callerKind: string }): CrawlCallerKind | 'legacy' {
  return job.callerKind === 'service' ||
    job.callerKind === 'key' ||
    job.callerKind === 'session' ||
    job.callerKind === 'reconciled_legacy_external'
    ? job.callerKind
    : 'legacy';
}

/**
 * Lease and crawl pages, up to `concurrency` at once, until stopped. `tick`
 * runs between leases (maintenance beats). A page that throws is reported to
 * `onError` and its lease simply expires; it never takes the other pages in
 * flight, or the worker, down. Resolves once every page in flight has finished.
 */
export async function runCrawlSlots<Page>(options: {
  concurrency: number;
  isStopping: () => boolean;
  tick: () => Promise<void>;
  lease: () => Promise<Page | undefined>;
  process: (page: Page) => Promise<void>;
  onError: (error: unknown, page: Page) => void;
  idleMs?: number;
}): Promise<void> {
  const active = new Set<Promise<void>>();
  while (!options.isStopping()) {
    await options.tick();
    if (active.size >= options.concurrency) {
      await Promise.race(active);
      continue;
    }
    const page = await options.lease();
    if (page === undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.idleMs ?? 1000));
      continue;
    }
    const run: Promise<void> = options
      .process(page)
      .catch((error: unknown) => options.onError(error, page))
      .finally(() => {
        active.delete(run);
      });
    active.add(run);
  }
  await Promise.all(active);
}

async function main() {
  if (!connectPostgres(process.env.DATABASE_URL)) throw new Error('DATABASE_URL is required');
  let stopping = false;
  const activity = startPlatformActivity(() => !stopping, 'clarity-worker');
  let nextMaintenanceAt = 0;
  let nextAccountEventSyncAt = 0;
  let nextOxyFilesAt = 0;
  process.once('SIGTERM', () => {
    stopping = true;
  });
  process.once('SIGINT', () => {
    stopping = true;
  });
  const feedLoop = runFeedLoop(() => stopping);
  const iconRefreshLoop = runIconRefreshLoop(() => stopping);
  const productFeedLoop = runProductFeedLoop(() => stopping);
  const embeddingBacklogLoop = runEmbeddingBacklogLoop(() => stopping);
  await runCrawlSlots({
    concurrency: crawlConcurrency,
    isStopping: () => stopping,
    tick: async () => {
      if (Date.now() >= nextAccountEventSyncAt) {
        nextAccountEventSyncAt = Date.now() + 60_000;
        try {
          await reconcileAccountEvents();
        } catch (error) {
          log.error(
            { err: error },
            'Account event reconciliation failed; the durable cursor is unchanged',
          );
        }
      }
      if (Date.now() >= nextMaintenanceAt) {
        nextMaintenanceAt = Date.now() + jobMaintenanceIntervalMs;
        await runJobMaintenance();
        await runImageCacheSweep();
        await runEffectReceiptSweep();
      }
      if (Date.now() >= nextOxyFilesAt) {
        nextOxyFilesAt = Date.now() + oxyFilesIntervalMs;
        await runOxyFiles();
      }
    },
    lease: leaseNextPage,
    process: processPage,
    onError: (error, page) =>
      log.error({ crawlPageId: page.id, err: error }, 'Crawl page failed; its lease will expire'),
  });
  await feedLoop;
  await iconRefreshLoop;
  await productFeedLoop;
  await embeddingBacklogLoop;
  await activity?.stop();
  await closePostgres();
}

if (import.meta.main)
  main().catch((error: unknown) => {
    log.fatal({ err: error }, 'Clarity worker failed');
    process.exit(1);
  });
