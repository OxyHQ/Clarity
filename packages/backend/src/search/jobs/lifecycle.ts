/**
 * Job lifecycle policy.
 *
 * Listings disappear far faster than ordinary web documents, so Clarity treats
 * absence as a signal. A listing leaves the default active corpus when the
 * source said it would (`validThrough`), when the source withdrew it (404/410,
 * the page no longer carries a `JobPosting`, or a first-party close), when its
 * document is removed, or when it simply stops being re-observed.
 *
 * The stored `status` is swept periodically so counters stay honest, and the
 * same policy is re-evaluated at query time so a listing can never surface as
 * active between two sweeps.
 */
import { sql, type SQL } from 'drizzle-orm';

import type { JobLifecycleStatus } from '@clarity/shared-types';

import { getDb } from '../../db/index.js';
import { jobPostings, searchDocuments } from '../../db/schema/index.js';

/**
 * How long a listing with no declared `validThrough` stays in the active
 * corpus after it was last observed. Chosen to outlive a normal recrawl cycle
 * by a wide margin while keeping abandoned listings out of default results.
 */
export const JOB_STALE_AFTER_DAYS = 45;

/** Target recrawl cadence for a listing that is still active. */
export const JOB_RECRAWL_INTERVAL_SECONDS = 86_400;

/** Reasons Clarity records when a source withdraws a listing. */
export const JOB_CLOSURE_REASONS = ['http_gone', 'posting_absent', 'source_closed', 'document_removed'] as const;
export type JobClosureReason = (typeof JOB_CLOSURE_REASONS)[number];

export function jobLifecycleStatus(input: {
  validThrough?: Date | null;
  lastSeenAt: Date;
  closedAt?: Date | null;
  documentStatus?: string | null;
  now?: Date;
}): JobLifecycleStatus {
  const now = input.now ?? new Date();
  if (input.documentStatus === 'removed' || input.documentStatus === 'blocked') return 'removed';
  if (input.closedAt) return 'closed';
  if (input.validThrough) return input.validThrough.getTime() <= now.getTime() ? 'expired' : 'active';
  const staleAfterMs = JOB_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  return now.getTime() - input.lastSeenAt.getTime() > staleAfterMs ? 'stale' : 'active';
}

/**
 * Query-time guard applied on top of the stored status, so an expiry that
 * happened since the last sweep still removes the listing from active results.
 */
export function activeJobPredicate(): SQL {
  return sql`(
    ${jobPostings.status} = 'active'
    and ${jobPostings.closedAt} is null
    and (${jobPostings.validThrough} is null or ${jobPostings.validThrough} > now())
    and (${jobPostings.validThrough} is not null or ${jobPostings.lastSeenAt} > now() - interval '${sql.raw(String(JOB_STALE_AFTER_DAYS))} days')
  )`;
}

export interface JobLifecycleSweep {
  expired: number;
  stale: number;
  removed: number;
  reactivated: number;
}

/** Reconciles stored statuses with the policy above. Safe to run repeatedly. */
export async function sweepJobLifecycle(): Promise<JobLifecycleSweep> {
  const database = getDb();
  const staleInterval = sql.raw(`interval '${JOB_STALE_AFTER_DAYS} days'`);

  const removed = await database.execute<{ id: string }>(sql`
    update ${jobPostings} set status = 'removed', updated_at = now()
    from ${searchDocuments}
    where ${searchDocuments.id} = ${jobPostings.documentId}
      and ${searchDocuments.status} in ('removed', 'blocked')
      and ${jobPostings.status} <> 'removed'
    returning ${jobPostings.id} as id`);

  const expired = await database.execute<{ id: string }>(sql`
    update ${jobPostings} set status = 'expired', updated_at = now()
    where ${jobPostings.status} = 'active'
      and ${jobPostings.validThrough} is not null
      and ${jobPostings.validThrough} <= now()
    returning ${jobPostings.id} as id`);

  const stale = await database.execute<{ id: string }>(sql`
    update ${jobPostings} set status = 'stale', updated_at = now()
    where ${jobPostings.status} = 'active'
      and ${jobPostings.validThrough} is null
      and ${jobPostings.lastSeenAt} < now() - ${staleInterval}
    returning ${jobPostings.id} as id`);

  const reactivated = await database.execute<{ id: string }>(sql`
    update ${jobPostings} set status = 'active', updated_at = now()
    where ${jobPostings.status} in ('expired', 'stale')
      and ${jobPostings.closedAt} is null
      and (${jobPostings.validThrough} is null or ${jobPostings.validThrough} > now())
      and (${jobPostings.validThrough} is not null or ${jobPostings.lastSeenAt} >= now() - ${staleInterval})
    returning ${jobPostings.id} as id`);

  return {
    expired: expired.length,
    stale: stale.length,
    removed: removed.length,
    reactivated: reactivated.length,
  };
}
