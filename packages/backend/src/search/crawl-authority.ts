import { sql, type SQLWrapper } from 'drizzle-orm';

/** Reviewed old external provenance is bounded without inventing key vs JWT origin. */
export type CrawlCallerKind = 'service' | 'key' | 'session' | 'reconciled_legacy_external';

/** Temporary rolling-deploy hold: absence of provenance is not external classification. */
export function hasClassifiedCrawlAuthority(job: {
  callerAuthority: string;
  callerKind: string;
}): boolean {
  if (job.callerAuthority === 'first_party')
    return job.callerKind === 'service' || job.callerKind === 'session';
  return (
    job.callerAuthority === 'external' &&
    ['service', 'key', 'session', 'reconciled_legacy_external'].includes(job.callerKind)
  );
}

export function classifiedCrawlAuthoritySql(authority: SQLWrapper, kind: SQLWrapper) {
  return sql`((${authority} = 'first_party' and ${kind} in ('service', 'session')) or (${authority} = 'external' and ${kind} in ('service', 'key', 'session', 'reconciled_legacy_external')))`;
}
