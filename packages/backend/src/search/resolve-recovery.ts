import { sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';

export interface ResolveRecoveryScope {
  ownerAccountId: string;
  applicationId: string;
  before: Date;
  limit: number;
}

/**
 * Coalesce only untouched duplicate reads from /resolve. Keep every row as an
 * audit record, and never replace an explicit index request, retry or fetch.
 * Scope and cutoff are mandatory; default invocation is a read-only preview.
 */
export async function recoverDuplicateResolves(scope: ResolveRecoveryScope, apply = false) {
  if (!scope.ownerAccountId || !scope.applicationId || !Number.isFinite(scope.before.getTime())
    || !Number.isInteger(scope.limit) || scope.limit < 1 || scope.limit > 5000) throw new Error('Invalid bounded resolve recovery scope');
  return getDb().transaction(async (tx) => {
    if (!apply) await tx.execute(sql`set transaction read only`);
    await tx.execute(sql`set local statement_timeout = '30s'`);
    await tx.execute(sql`set local lock_timeout = '5s'`);
    if (apply) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${scope.ownerAccountId}:active_crawls`}, 0))`);
    const candidates = sql`
      with ranked as (
        select p.id, p.job_id, p.url, p.status, p.attempt_count, p.lease_owner, p.lease_expires_at, p.created_at,
          first_value(p.id) over (
            partition by p.url, j.credential_id, j.caller_tier
            order by case p.status when 'fetching' then 0 else 1 end, p.priority desc,
              case p.status when 'retry' then 0 else 1 end, p.created_at, p.id
          ) as retained_id
        from clarity_crawl_pages p join clarity_crawl_jobs j on j.id = p.job_id
        where j.owner_account_id = ${scope.ownerAccountId} and j.application_id = ${scope.applicationId}
          and j.kind = 'urls' and j.idempotency_key like 'resolve:%'
          and j.status in ('queued', 'running') and p.status in ('queued', 'retry', 'fetching')
      )
      select id, job_id, url, retained_id from ranked
      where id <> retained_id and status = 'queued' and attempt_count = 0
        and lease_owner is null and lease_expires_at is null
        and created_at < ${scope.before.toISOString()}::timestamptz
      order by created_at, id limit ${scope.limit}`;
    const rows = await tx.execute<{ id: string; job_id: string; url: string; retained_id: string }>(apply ? sql`
      with candidates as (${candidates}), locked as (
        select p.id, c.retained_id from clarity_crawl_pages p join candidates c on c.id = p.id
        where p.status = 'queued' and p.attempt_count = 0 and p.lease_owner is null and p.lease_expires_at is null
        for update of p skip locked
      )
      update clarity_crawl_pages p set status = 'failed', last_error_code = 'resolve_superseded',
        last_error_detail = 'Duplicate resolve; retained page ' || locked.retained_id, updated_at = now()
      from locked where p.id = locked.id
      returning p.id, p.job_id, p.url, locked.retained_id` : candidates);
    let operationsFinished = 0;
    if (apply && rows.length) {
      const ids = [...new Set(rows.map((row) => row.job_id))];
      const finished = await tx.execute<{ id: string }>(sql`
        update clarity_crawl_jobs j set
          status = case when not exists (
            select 1 from clarity_crawl_pages p where p.job_id = j.id
              and (p.status <> 'failed' or p.last_error_code is distinct from 'resolve_superseded')
          ) then 'cancelled' else 'partial' end,
          error_code = 'resolve_superseded', error_detail = 'Duplicate resolve pages coalesced; audit rows retained',
          finished_at = now(), updated_at = now()
        where j.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
          and j.owner_account_id = ${scope.ownerAccountId} and j.application_id = ${scope.applicationId}
          and j.status in ('queued', 'running')
          and not exists (select 1 from clarity_crawl_pages p where p.job_id = j.id and p.status not in ('succeeded', 'failed'))
        returning j.id`);
      operationsFinished = finished.length;
    }
    return { apply, ownerAccountId: scope.ownerAccountId, applicationId: scope.applicationId, before: scope.before.toISOString(), limit: scope.limit, pages: rows.length, operationsFinished, sample: rows.slice(0, 10) };
  });
}
