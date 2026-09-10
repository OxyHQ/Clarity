#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { and, eq, lt, or, sql } from 'drizzle-orm';
import { safeFetch } from '@oxy.so/core/server';

import { closePostgres, connectPostgres, getDb } from './db/index.js';
import { crawlJobs, crawlPages, fetchAttempts, searchDocuments } from './db/schema/index.js';
import { extractDocument } from './search/extractor.js';
import { chunkText, embedChunks, replaceDocumentChunks } from './search/chunking.js';
import { extractJobPostings } from './search/jobs/extract.js';
import { JOB_RECRAWL_INTERVAL_SECONDS, sweepJobLifecycle } from './search/jobs/lifecycle.js';
import { closeJobPostingsForDocument, projectJobPostings } from './search/jobs/projection.js';
import { pollDueJobFeeds } from './search/jobs/feeds/poll.js';
import { consumeUsage, effectiveQuota } from './search/quotas.js';

const workerId = process.env.CLARITY_WORKER_ID || `worker:${process.pid}:${crypto.randomUUID()}`;
const leaseSeconds = 60;
const maxBodyBytes = 5 * 1024 * 1024;
const extractorVersion = 'readability-0.6.0';
/** How often stored job statuses are reconciled with the lifecycle policy. */
const jobMaintenanceIntervalMs = 15 * 60 * 1000;
const jobRecrawlBatchSize = 50;

export async function leaseNextPage() {
  return getDb().transaction(async (tx) => {
    const [page] = await tx.select().from(crawlPages).where(and(
      or(eq(crawlPages.status, 'queued'), eq(crawlPages.status, 'retry')),
      lt(crawlPages.availableAt, new Date()),
      or(sql`${crawlPages.leaseExpiresAt} is null`, lt(crawlPages.leaseExpiresAt, new Date())),
    )).orderBy(crawlPages.availableAt).limit(1).for('update', { skipLocked: true });
    if (!page) return undefined;
    const [job] = await tx.select({ ownerAccountId: crawlJobs.ownerAccountId }).from(crawlJobs).where(eq(crawlJobs.id, page.jobId)).limit(1);
    if (!job) throw new Error(`Crawl job ${page.jobId} does not exist`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${job.ownerAccountId}:concurrent_fetches`}, 0))`);
    const concurrencyLimit = await effectiveQuota(tx, job.ownerAccountId, 'concurrent_fetches');
    const [active] = await tx.select({ quantity: sql<number>`count(*)::int` }).from(crawlPages).innerJoin(crawlJobs, eq(crawlPages.jobId, crawlJobs.id)).where(and(eq(crawlJobs.ownerAccountId, job.ownerAccountId), eq(crawlPages.status, 'fetching')));
    if (active.quantity >= concurrencyLimit) return undefined;
    const [leased] = await tx.update(crawlPages).set({ status: 'fetching', leaseOwner: workerId, leaseExpiresAt: sql`now() + interval '${sql.raw(String(leaseSeconds))} seconds'`, heartbeatAt: new Date(), attemptCount: page.attemptCount + 1, updatedAt: new Date() }).where(eq(crawlPages.id, page.id)).returning();
    await tx.update(crawlJobs).set({ status: 'running', startedAt: sql`coalesce(${crawlJobs.startedAt}, now())`, updatedAt: new Date() }).where(eq(crawlJobs.id, page.jobId));
    return leased;
  });
}

export async function processPage(page: typeof crawlPages.$inferSelect): Promise<void> {
  const startedAt = Date.now();
  const attemptId = crypto.randomUUID();
  const [job] = await getDb().select().from(crawlJobs).where(eq(crawlJobs.id, page.jobId)).limit(1);
  if (!job) throw new Error(`Crawl job ${page.jobId} does not exist`);
  const principal = { accountId: job.ownerAccountId, applicationId: job.applicationId, credentialId: job.credentialId ?? undefined };
  const fetchUsage = await consumeUsage({ principal, operation: 'fetch_started', idempotencyKey: `crawl-page:${page.id}:attempt:${page.attemptCount}` });
  if (!fetchUsage.accepted) {
    await getDb().transaction(async (tx) => {
      await tx.update(crawlPages).set({ status: 'failed', leaseOwner: null, leaseExpiresAt: null, lastErrorCode: 'fetch_quota_exceeded', lastErrorDetail: 'The monthly fetch quota has been exhausted', updatedAt: new Date() }).where(eq(crawlPages.id, page.id));
      await tx.update(crawlJobs).set({ errorCode: 'fetch_quota_exceeded', errorDetail: 'The monthly fetch quota has been exhausted', updatedAt: new Date() }).where(eq(crawlJobs.id, page.jobId));
      await finishJobIfComplete(tx, page.jobId);
    });
    return;
  }
  await getDb().transaction(async (tx) => {
    await tx.insert(fetchAttempts).values({ id: attemptId, crawlPageId: page.id, attempt: page.attemptCount, fetchMode: 'http', status: 'running' });
  });
  try {
    const result = await safeFetch(page.url, { headers: { 'User-Agent': 'ClarityBot/0.1 (+https://clarity.surf/bot)', accept: 'text/html,application/xhtml+xml' }, maxRedirects: 5, headersTimeoutMs: 15_000 });
    // A listing that answers 404/410 has been withdrawn by its source. Record
    // the removal instead of indexing the error page.
    if (result.status === 404 || result.status === 410) {
      result.response.destroy();
      await recordGoneDocument(page, result.finalUrl, result.status, attemptId, startedAt);
      return;
    }
    if (result.status >= 400) { result.response.destroy(); throw new Error(`http_status_${result.status}`); }
    const contentType = Array.isArray(result.headers['content-type']) ? result.headers['content-type'][0] : result.headers['content-type'];
    if (!contentType?.includes('text/html')) { result.response.destroy(); throw new Error('unsupported_content_type'); }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of result.response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBodyBytes) { result.response.destroy(); throw new Error('response_too_large'); }
      chunks.push(buffer);
    }
    const html = Buffer.concat(chunks).toString('utf8');
    const extracted = extractDocument(html, result.finalUrl);
    const canonicalUrl = extracted.canonicalUrl || result.finalUrl;
    const contentHash = createHash('sha256').update(extracted.mainContent || '').digest('hex');
    const textChunks = extracted.noindex ? [] : chunkText(extracted.mainContent || '');
    const observedAt = new Date();
    const postings = extracted.noindex
      ? []
      : extractJobPostings(extracted.structuredData, canonicalUrl, observedAt.toISOString(), 'json_ld');
    let embeddings: number[][] | undefined;
    if (textChunks.length > 0) {
      try {
        embeddings = await embedChunks(textChunks.map((item) => item.text));
      } catch (error) {
        console.error('Embedding generation failed; document remains lexically searchable', {
          crawlPageId: page.id,
          error: error instanceof Error ? error.message : 'unknown embedding failure',
        });
      }
    }
    await getDb().transaction(async (tx) => {
      const documentStatus = extracted.noindex ? 'blocked' : 'indexed';
      const nextFetchAt = postings.length > 0
        ? new Date(observedAt.getTime() + JOB_RECRAWL_INTERVAL_SECONDS * 1000)
        : null;
      const mutable = {
        siteId: job.siteId, finalUrl: result.finalUrl, status: documentStatus, documentType: extracted.documentType,
        contentHash, httpStatus: result.status, etag: header(result.headers.etag), lastModified: header(result.headers['last-modified']),
        contentType, language: extracted.language, title: extracted.title, description: extracted.description,
        mainContent: extracted.mainContent, structuredData: extracted.structuredData, fieldEvidence: extracted.evidence,
        imageUrl: extracted.imageUrl, faviconUrl: extracted.faviconUrl, noindex: extracted.noindex, nofollow: extracted.nofollow,
        fetchedAt: observedAt, indexedAt: extracted.noindex ? undefined : observedAt, nextFetchAt,
      };
      const [document] = await tx.insert(searchDocuments)
        .values({ id: crypto.randomUUID(), requestedUrl: page.url, canonicalUrl, ...mutable })
        .onConflictDoUpdate({ target: searchDocuments.canonicalUrl, set: { ...mutable, updatedAt: observedAt } })
        .returning();
      await replaceDocumentChunks(tx, document.id, textChunks, embeddings, extractorVersion);
      await projectJobPostings(tx, {
        documentId: document.id,
        documentStatus,
        postings,
        sourceType: job.siteId ? 'verified_site' : 'web',
        observedAt,
      });
      await tx.update(crawlPages).set({ status: 'succeeded', leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() }).where(eq(crawlPages.id, page.id));
      await tx.update(crawlJobs).set({ pagesCompleted: sql`${crawlJobs.pagesCompleted} + 1`, updatedAt: new Date() }).where(eq(crawlJobs.id, page.jobId));
      await tx.update(fetchAttempts).set({ status: 'succeeded', httpStatus: result.status, bytesReceived: bytes, durationMs: Date.now() - startedAt, finishedAt: new Date() }).where(eq(fetchAttempts.id, attemptId));
      await finishJobIfComplete(tx, page.jobId);
    });
    if (!extracted.noindex) await consumeUsage({ principal, operation: 'page_indexed', idempotencyKey: `crawl-page:${page.id}:indexed` });
  } catch (error) {
    const retry = page.attemptCount < 3;
    const detail = error instanceof Error ? error.message.slice(0, 500) : 'unknown fetch failure';
    await getDb().transaction(async (tx) => {
      await tx.update(crawlPages).set({ status: retry ? 'retry' : 'failed', availableAt: sql`now() + (${2 ** page.attemptCount} * interval '1 minute')`, leaseOwner: null, leaseExpiresAt: null, lastErrorCode: 'fetch_failed', lastErrorDetail: detail, updatedAt: new Date() }).where(eq(crawlPages.id, page.id));
      await tx.update(fetchAttempts).set({ status: 'failed', durationMs: Date.now() - startedAt, errorCode: 'fetch_failed', errorDetail: detail, finishedAt: new Date() }).where(eq(fetchAttempts.id, attemptId));
      if (!retry) await finishJobIfComplete(tx, page.jobId);
    });
  }
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
    const [document] = await tx.update(searchDocuments)
      .set({ status: 'removed', httpStatus: status, finalUrl, fetchedAt: new Date(), nextFetchAt: null, updatedAt: new Date() })
      .where(or(eq(searchDocuments.requestedUrl, page.url), eq(searchDocuments.canonicalUrl, page.url)))
      .returning({ id: searchDocuments.id });
    if (document) await closeJobPostingsForDocument(tx, document.id, 'http_gone');
    await tx.update(crawlPages).set({ status: 'succeeded', leaseOwner: null, leaseExpiresAt: null, lastErrorCode: 'http_gone', updatedAt: new Date() }).where(eq(crawlPages.id, page.id));
    await tx.update(crawlJobs).set({ pagesCompleted: sql`${crawlJobs.pagesCompleted} + 1`, updatedAt: new Date() }).where(eq(crawlJobs.id, page.jobId));
    await tx.update(fetchAttempts).set({ status: 'succeeded', httpStatus: status, durationMs: Date.now() - startedAt, finishedAt: new Date() }).where(eq(fetchAttempts.id, attemptId));
    await finishJobIfComplete(tx, page.jobId);
  });
}

async function finishJobIfComplete(tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0], jobId: string) {
  const [{ pending }] = await tx.select({ pending: sql<number>`count(*) filter (where ${crawlPages.status} not in ('succeeded', 'failed'))::int` }).from(crawlPages).where(eq(crawlPages.jobId, jobId));
  if (pending === 0) {
    const [{ failed }] = await tx.select({ failed: sql<number>`count(*) filter (where ${crawlPages.status} = 'failed')::int` }).from(crawlPages).where(eq(crawlPages.jobId, jobId));
    await tx.update(crawlJobs).set({ status: failed > 0 ? 'partial' : 'succeeded', finishedAt: new Date(), updatedAt: new Date() }).where(eq(crawlJobs.id, jobId));
  }
}

/**
 * Re-queues job documents that are due for verification, under the same owner
 * that originally requested them, so a listing's disappearance is noticed.
 */
interface DueJobDocument extends Record<string, unknown> {
  documentId: string;
  url: string;
  ownerAccountId: string;
  applicationId: string;
  credentialId: string | null;
  siteId: string | null;
}

export async function enqueueJobRecrawls(): Promise<number> {
  const due = await getDb().execute<DueJobDocument>(sql`
    select ${searchDocuments.id} as "documentId", ${searchDocuments.canonicalUrl} as url,
      origin.owner_account_id as "ownerAccountId", origin.application_id as "applicationId",
      origin.credential_id as "credentialId", origin.site_id as "siteId"
    from ${searchDocuments}
    join lateral (
      select ${crawlJobs.ownerAccountId} as owner_account_id, ${crawlJobs.applicationId} as application_id,
        ${crawlJobs.credentialId} as credential_id, ${crawlJobs.siteId} as site_id
      from ${crawlPages} join ${crawlJobs} on ${crawlJobs.id} = ${crawlPages.jobId}
      where ${crawlPages.url} = ${searchDocuments.requestedUrl}
      order by ${crawlPages.createdAt} desc limit 1
    ) as origin on true
    where ${searchDocuments.documentType} = 'job'
      and ${searchDocuments.status} = 'indexed'
      and ${searchDocuments.nextFetchAt} is not null
      and ${searchDocuments.nextFetchAt} <= now()
    limit ${jobRecrawlBatchSize}`);
  if (due.length === 0) return 0;

  const batches = new Map<string, DueJobDocument[]>();
  for (const row of due) {
    const key = `${row.ownerAccountId}|${row.applicationId}|${row.credentialId ?? ''}|${row.siteId ?? ''}`;
    batches.set(key, [...(batches.get(key) ?? []), row]);
  }
  const cycle = new Date(Date.now() + JOB_RECRAWL_INTERVAL_SECONDS * 1000);
  await getDb().transaction(async (tx) => {
    for (const rows of batches.values()) {
      const [first] = rows;
      const urls = [...new Set(rows.map((row) => row.url))];
      const [operation] = await tx.insert(crawlJobs).values({
        id: crypto.randomUUID(), ownerAccountId: first.ownerAccountId, applicationId: first.applicationId,
        credentialId: first.credentialId, siteId: first.siteId, kind: 'recrawl',
        idempotencyKey: `job-recrawl:${new Date().toISOString()}:${crypto.randomUUID()}`,
        requestedUrls: urls, pagesDiscovered: urls.length,
      }).returning();
      await tx.insert(crawlPages)
        .values(urls.map((url) => ({ id: crypto.randomUUID(), jobId: operation.id, url, discoverySource: 'recrawl' })))
        .onConflictDoNothing();
    }
    await tx.update(searchDocuments)
      .set({ nextFetchAt: cycle, updatedAt: new Date() })
      .where(sql`${searchDocuments.id} in (${sql.join(due.map((row) => sql`${row.documentId}`), sql`, `)})`);
  });
  return due.length;
}

async function runJobMaintenance(): Promise<void> {
  try {
    const sweep = await sweepJobLifecycle();
    const recrawls = await enqueueJobRecrawls();
    // Supply, after upkeep: a failing feed is recorded on its own row, so this
    // never blocks the sweep or the recrawls above.
    const feeds = await pollDueJobFeeds();
    console.info('Job corpus maintenance completed', { ...sweep, recrawls, feeds });
  } catch (error) {
    console.error('Job corpus maintenance failed', {
      error: error instanceof Error ? error.message : 'unknown maintenance failure',
    });
  }
}

function header(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }

async function main() {
  if (!connectPostgres(process.env.DATABASE_URL)) throw new Error('DATABASE_URL is required');
  let stopping = false;
  let nextMaintenanceAt = 0;
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  while (!stopping) {
    if (Date.now() >= nextMaintenanceAt) {
      nextMaintenanceAt = Date.now() + jobMaintenanceIntervalMs;
      await runJobMaintenance();
    }
    const page = await leaseNextPage();
    if (page) await processPage(page);
    else await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await closePostgres();
}

if (import.meta.main) main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
