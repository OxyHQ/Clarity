#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { and, eq, lt, or, sql } from 'drizzle-orm';
import { safeFetch } from '@oxyhq/core/server';

import { closePostgres, connectPostgres, getDb } from './db/index.js';
import { crawlJobs, crawlPages, fetchAttempts, searchChunks, searchDocuments, searchUsageEvents } from './db/schema/index.js';
import { extractDocument } from './search/extractor.js';
import { CLARITY_EMBEDDING_MODEL, createOxyEmbeddings } from './lib/oxy-embeddings.js';

const workerId = process.env.CLARITY_WORKER_ID || `worker:${process.pid}:${crypto.randomUUID()}`;
const leaseSeconds = 60;
const maxBodyBytes = 5 * 1024 * 1024;

export async function leaseNextPage() {
  return getDb().transaction(async (tx) => {
    const [page] = await tx.select().from(crawlPages).where(and(
      or(eq(crawlPages.status, 'queued'), eq(crawlPages.status, 'retry')),
      lt(crawlPages.availableAt, new Date()),
      or(sql`${crawlPages.leaseExpiresAt} is null`, lt(crawlPages.leaseExpiresAt, new Date())),
    )).orderBy(crawlPages.availableAt).limit(1).for('update', { skipLocked: true });
    if (!page) return undefined;
    const [leased] = await tx.update(crawlPages).set({ status: 'fetching', leaseOwner: workerId, leaseExpiresAt: sql`now() + interval '${sql.raw(String(leaseSeconds))} seconds'`, heartbeatAt: new Date(), attemptCount: page.attemptCount + 1, updatedAt: new Date() }).where(eq(crawlPages.id, page.id)).returning();
    await tx.update(crawlJobs).set({ status: 'running', startedAt: sql`coalesce(${crawlJobs.startedAt}, now())`, updatedAt: new Date() }).where(eq(crawlJobs.id, page.jobId));
    return leased;
  });
}

export async function processPage(page: typeof crawlPages.$inferSelect): Promise<void> {
  const startedAt = Date.now();
  const attemptId = crypto.randomUUID();
  await getDb().transaction(async (tx) => {
    const [job] = await tx.select().from(crawlJobs).where(eq(crawlJobs.id, page.jobId)).limit(1);
    await tx.insert(fetchAttempts).values({ id: attemptId, crawlPageId: page.id, attempt: page.attemptCount, fetchMode: 'http', status: 'running' });
    await tx.insert(searchUsageEvents).values({ id: crypto.randomUUID(), ownerAccountId: job.ownerAccountId, applicationId: job.applicationId, credentialId: job.credentialId, operation: 'fetch_started' });
  });
  try {
    const result = await safeFetch(page.url, { headers: { 'User-Agent': 'ClarityBot/0.1 (+https://clarity.surf/bot)', accept: 'text/html,application/xhtml+xml' }, maxRedirects: 5, headersTimeoutMs: 15_000 });
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
      const [document] = await tx.insert(searchDocuments).values({ id: crypto.randomUUID(), requestedUrl: page.url, finalUrl: result.finalUrl, canonicalUrl, status: extracted.noindex ? 'blocked' : 'indexed', documentType: extracted.documentType, contentHash, httpStatus: result.status, etag: header(result.headers.etag), lastModified: header(result.headers['last-modified']), contentType, language: extracted.language, title: extracted.title, description: extracted.description, mainContent: extracted.mainContent, structuredData: extracted.structuredData, fieldEvidence: extracted.evidence, imageUrl: extracted.imageUrl, faviconUrl: extracted.faviconUrl, noindex: extracted.noindex, nofollow: extracted.nofollow, fetchedAt: new Date(), indexedAt: extracted.noindex ? undefined : new Date() }).onConflictDoUpdate({ target: searchDocuments.canonicalUrl, set: { finalUrl: result.finalUrl, status: extracted.noindex ? 'blocked' : 'indexed', documentType: extracted.documentType, contentHash, httpStatus: result.status, etag: header(result.headers.etag), lastModified: header(result.headers['last-modified']), contentType, language: extracted.language, title: extracted.title, description: extracted.description, mainContent: extracted.mainContent, structuredData: extracted.structuredData, fieldEvidence: extracted.evidence, imageUrl: extracted.imageUrl, faviconUrl: extracted.faviconUrl, noindex: extracted.noindex, nofollow: extracted.nofollow, fetchedAt: new Date(), indexedAt: extracted.noindex ? undefined : new Date(), updatedAt: new Date() } }).returning();
      await tx.delete(searchChunks).where(eq(searchChunks.documentId, document.id));
      if (textChunks.length > 0) await tx.insert(searchChunks).values(textChunks.map((item, position) => ({
        id: crypto.randomUUID(), documentId: document.id, position, startOffset: item.start,
        endOffset: item.end, text: item.text, searchVector: sql`to_tsvector('simple', ${item.text})`,
        embedding: embeddings?.[position], embeddingModel: embeddings ? CLARITY_EMBEDDING_MODEL : undefined,
        extractorVersion: 'readability-0.6.0',
      })));
      await tx.update(crawlPages).set({ status: 'succeeded', leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() }).where(eq(crawlPages.id, page.id));
      await tx.update(crawlJobs).set({ pagesCompleted: sql`${crawlJobs.pagesCompleted} + 1`, updatedAt: new Date() }).where(eq(crawlJobs.id, page.jobId));
      const [job] = await tx.select().from(crawlJobs).where(eq(crawlJobs.id, page.jobId)).limit(1);
      if (!extracted.noindex) await tx.insert(searchUsageEvents).values({ id: crypto.randomUUID(), ownerAccountId: job.ownerAccountId, applicationId: job.applicationId, credentialId: job.credentialId, operation: 'page_indexed' });
      await tx.update(fetchAttempts).set({ status: 'succeeded', httpStatus: result.status, bytesReceived: bytes, durationMs: Date.now() - startedAt, finishedAt: new Date() }).where(eq(fetchAttempts.id, attemptId));
      await finishJobIfComplete(tx, page.jobId);
    });
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

async function finishJobIfComplete(tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0], jobId: string) {
  const [{ pending }] = await tx.select({ pending: sql<number>`count(*) filter (where ${crawlPages.status} not in ('succeeded', 'failed'))::int` }).from(crawlPages).where(eq(crawlPages.jobId, jobId));
  if (pending === 0) {
    const [{ failed }] = await tx.select({ failed: sql<number>`count(*) filter (where ${crawlPages.status} = 'failed')::int` }).from(crawlPages).where(eq(crawlPages.jobId, jobId));
    await tx.update(crawlJobs).set({ status: failed > 0 ? 'partial' : 'succeeded', finishedAt: new Date(), updatedAt: new Date() }).where(eq(crawlJobs.id, jobId));
  }
}

function chunkText(text: string): Array<{ start: number; end: number; text: string }> {
  const result: Array<{ start: number; end: number; text: string }> = [];
  for (let start = 0; start < text.length; start += 1600) {
    const end = Math.min(start + 2000, text.length);
    result.push({ start, end, text: text.slice(start, end) });
  }
  return result;
}
async function embedChunks(texts: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let start = 0; start < texts.length; start += 128) {
    embeddings.push(...await createOxyEmbeddings(texts.slice(start, start + 128)));
  }
  return embeddings;
}
function header(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }

async function main() {
  if (!connectPostgres(process.env.DATABASE_URL)) throw new Error('DATABASE_URL is required');
  let stopping = false;
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  while (!stopping) {
    const page = await leaseNextPage();
    if (page) await processPage(page);
    else await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await closePostgres();
}

if (import.meta.main) main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
