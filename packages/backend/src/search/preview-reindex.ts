/**
 * Re-queues the link previews that ended without a document for a cause
 * Clarity has since fixed, so their cards arrive without anyone posting the
 * link again (docs/crawl-recovery.md, "Failed previews").
 *
 * A candidate is a URL whose latest resolve crawl, for one owner and
 * application, ended with no document answering to it, and nothing queued for
 * it now. Its cause is one of:
 *
 * - `oembed` — a registered oEmbed provider covers it (search/oembed.ts);
 * - `extraction` — the page was fetched but extraction crashed (fixed markup
 *   parsing and Readability failures, search/extractor.ts);
 * - `unmatched` — the fetch succeeded but its document never answered to the
 *   URL (a share link merged into another canonical, or a broken canonical);
 * - `transient` — the site was rate limiting, erroring or unreachable, which
 *   older crawls recorded as a permanent failure.
 *
 * Each batch is one `resolve:` operation with the original caller's authority,
 * at background priority, and the next batch waits until it drains: live
 * reads keep their place in the queue, and the queue never holds more than one
 * batch of this work. The default is a read-only preview.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { getDb } from '../db/index.js';
import { crawlJobs, crawlPages } from '../db/schema/index.js';
import { isTransientFetchFailure, PageFetchError } from './fetch-failure.js';
import { registeredOembedUrl } from './oembed.js';

export type ReindexCause = 'oembed' | 'extraction' | 'unmatched' | 'transient';
export const REINDEX_CAUSES: readonly ReindexCause[] = [
  'oembed',
  'extraction',
  'unmatched',
  'transient',
];

export interface PreviewReindexScope {
  ownerAccountId: string;
  applicationId: string;
  since: Date;
  limit: number;
  batchSize: number;
  causes: readonly ReindexCause[];
}

type Candidate = {
  url: string;
  status: string;
  detail: string | null;
  credential_id: string | null;
  caller_tier: string;
  caller_authority: string;
  caller_kind: string;
};

const EXTRACTION_CRASH = /evaluating|Readability|destructure|firstElementChild/;

/** The cause a candidate is re-queued for, if any of `causes`. */
export function reindexCause(
  candidate: Pick<Candidate, 'url' | 'status' | 'detail'>,
  causes: readonly ReindexCause[],
): ReindexCause | undefined {
  const detail = candidate.detail ?? '';
  const status = /^http_status_(\d+)$/.exec(detail)?.[1];
  const matches: Record<ReindexCause, boolean> = {
    oembed: registeredOembedUrl(candidate.url) !== undefined,
    extraction: candidate.status === 'failed' && EXTRACTION_CRASH.test(detail),
    unmatched: candidate.status === 'succeeded',
    transient:
      candidate.status === 'failed' &&
      isTransientFetchFailure(
        status ? new PageFetchError(detail, Number(status)) : new Error(detail),
      ),
  };
  return causes.find((cause) => matches[cause]);
}

async function candidates(scope: PreviewReindexScope): Promise<Candidate[]> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    await tx.execute(sql`set local statement_timeout = '120s'`);
    return tx.execute<Candidate>(sql`
      with latest as (
        select distinct on (p.url) p.url, p.status, p.last_error_code, p.last_error_detail as detail,
          j.credential_id, j.caller_tier, j.caller_authority, j.caller_kind
        from clarity_crawl_pages p join clarity_crawl_jobs j on j.id = p.job_id
        where j.owner_account_id = ${scope.ownerAccountId} and j.application_id = ${scope.applicationId}
          and j.kind = 'urls' and j.idempotency_key like 'resolve:%'
          and p.created_at > ${scope.since.toISOString()}::timestamptz
        order by p.url, p.updated_at desc
      )
      select l.url, l.status, l.detail, l.credential_id, l.caller_tier, l.caller_authority, l.caller_kind
      from latest l
      where ((l.status = 'failed' and l.last_error_code in ('fetch_failed', 'fetch_unavailable'))
          or (l.status = 'succeeded' and l.last_error_code is null))
        and not exists (select 1 from clarity_search_documents d
          where (d.canonical_url = l.url or d.requested_url = l.url or d.final_url = l.url)
            and d.status <> 'discovered')
        and not exists (select 1 from clarity_search_document_urls a where a.url = l.url)
        and not exists (select 1 from clarity_crawl_pages q
          where q.url = l.url and q.status in ('queued', 'retry', 'fetching'))
      order by l.url`);
  });
}

/** Queues one batch as a resolve operation with its callers' authority. */
async function enqueue(scope: PreviewReindexScope, batch: Candidate[]): Promise<string[]> {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of batch) {
    const key = JSON.stringify([
      candidate.credential_id,
      candidate.caller_tier,
      candidate.caller_authority,
      candidate.caller_kind,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const jobIds: string[] = [];
  for (const group of groups.values()) {
    const urls = group.map((candidate) => candidate.url).sort();
    const [first] = group;
    const id = crypto.randomUUID();
    await getDb().transaction(async (tx) => {
      // Brief: one insert per batch under the lock every resolve of this owner takes.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${scope.ownerAccountId}:active_crawls`}, 0))`,
      );
      await tx.insert(crawlJobs).values({
        id,
        ownerAccountId: scope.ownerAccountId,
        applicationId: scope.applicationId,
        credentialId: first.credential_id,
        kind: 'urls',
        idempotencyKey: `resolve:reindex:${createHash('sha256').update(urls.join('\n')).digest('hex')}`,
        requestedUrls: urls,
        pagesDiscovered: urls.length,
        callerTier: first.caller_tier,
        callerAuthority: first.caller_authority,
        callerKind: first.caller_kind,
      });
      await tx.insert(crawlPages).values(
        urls.map((url) => ({
          id: crypto.randomUUID(),
          jobId: id,
          url,
          discoverySource: 'api',
          priority: 1,
        })),
      );
    });
    jobIds.push(id);
  }
  return jobIds;
}

async function drained(jobIds: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [{ pending }] = await getDb().execute<{ pending: number }>(sql`
      select count(*)::int as pending from clarity_crawl_pages
      where job_id in (${sql.join(
        jobIds.map((id) => sql`${id}`),
        sql`, `,
      )}) and status in ('queued', 'retry', 'fetching')`);
    if (pending === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}

export async function reindexFailedPreviews(
  scope: PreviewReindexScope,
  apply: boolean,
  log: (line: Record<string, unknown>) => void = (line) => console.info(JSON.stringify(line)),
) {
  if (
    !scope.ownerAccountId ||
    !scope.applicationId ||
    !Number.isFinite(scope.since.getTime()) ||
    !Number.isInteger(scope.limit) ||
    scope.limit < 1 ||
    !Number.isInteger(scope.batchSize) ||
    scope.batchSize < 1 ||
    scope.batchSize > 500 ||
    scope.causes.length === 0
  )
    throw new Error('Invalid bounded preview reindex scope');
  const found = await candidates(scope);
  const selected: Candidate[] = [];
  const byCause: Record<string, number> = {};
  for (const candidate of found) {
    const cause = reindexCause(candidate, scope.causes);
    if (!cause) continue;
    byCause[cause] = (byCause[cause] ?? 0) + 1;
    if (selected.length < scope.limit) selected.push(candidate);
  }
  log({
    candidates: found.length,
    byCause,
    selected: selected.length,
    sample: selected.slice(0, 10).map((candidate) => candidate.url),
    apply,
  });
  if (!apply) return { candidates: found.length, byCause, queued: 0 };
  let queued = 0;
  for (let start = 0; start < selected.length; start += scope.batchSize) {
    const batch = selected.slice(start, start + scope.batchSize);
    const jobIds = await enqueue(scope, batch);
    queued += batch.length;
    await drained(jobIds, 20 * 60 * 1000);
    log({ queued, of: selected.length });
  }
  return { candidates: found.length, byCause, queued };
}
