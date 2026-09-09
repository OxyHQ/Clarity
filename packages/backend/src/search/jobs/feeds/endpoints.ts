/**
 * Where each supported feed kind lives, and what its identifier means.
 *
 * Every endpoint here is PUBLIC and KEYLESS by design: Clarity registers with
 * no third party to read a public job board, so there is no credential to hold
 * and none of the provider credential custody rules are engaged. If a source ever
 * needs a key it does not belong in this table — it belongs behind an explicit
 * partner agreement.
 *
 * The listing's own URL always remains its canonical source; Clarity indexes,
 * it does not republish.
 */
import type { JobFeedKind } from '@clarity/shared-types';

export const JOB_FEED_KINDS = [
  'greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters',
  'remoteok', 'remotive', 'arbeitnow', 'rss',
] as const satisfies readonly JobFeedKind[];

/** How a kind's `identifier` column is interpreted, for operators and errors. */
export const JOB_FEED_IDENTIFIER_MEANING: Readonly<Record<JobFeedKind, string>> = Object.freeze({
  greenhouse: 'the board token in boards.greenhouse.io/<token>',
  lever: 'the company slug in jobs.lever.co/<slug>',
  ashby: 'the job board name in jobs.ashbyhq.com/<name>',
  workable: 'the account slug in apply.workable.com/<slug>',
  recruitee: 'the company slug in <slug>.recruitee.com',
  smartrecruiters: 'the company identifier in careers.smartrecruiters.com/<company>',
  remoteok: 'unused; leave it as the kind name',
  remotive: 'unused, or a category slug',
  arbeitnow: 'unused; leave it as the kind name',
  rss: 'the absolute https URL of the RSS or Atom feed',
});

/** Kinds whose identifier is a whole URL rather than a slug. */
export const URL_IDENTIFIER_KINDS: ReadonlySet<JobFeedKind> = new Set<JobFeedKind>(['rss']);

/** Kinds that take no identifier because the endpoint is a single fixed URL. */
export const FIXED_ENDPOINT_KINDS: ReadonlySet<JobFeedKind> = new Set<JobFeedKind>([
  'remoteok', 'arbeitnow',
]);

const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/;

/**
 * The request URL for one feed. Throws rather than guessing, so a malformed
 * identifier fails at registration instead of quietly fetching the wrong board.
 */
export function jobFeedUrl(kind: JobFeedKind, identifier: string): string {
  if (URL_IDENTIFIER_KINDS.has(kind)) {
    const url = new URL(identifier);
    if (url.protocol !== 'https:') throw new Error('An RSS feed identifier must be an https URL');
    return url.toString();
  }
  if (!FIXED_ENDPOINT_KINDS.has(kind) && !SLUG.test(identifier)) {
    throw new Error(`Identifier for ${kind} must be ${JOB_FEED_IDENTIFIER_MEANING[kind]}`);
  }
  const slug = encodeURIComponent(identifier);
  switch (kind) {
    case 'greenhouse': return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
    case 'lever': return `https://api.lever.co/v0/postings/${slug}?mode=json`;
    case 'ashby': return `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
    case 'workable': return `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`;
    case 'recruitee': return `https://${slug}.recruitee.com/api/offers/`;
    case 'smartrecruiters': return `https://api.smartrecruiters.com/v1/companies/${slug}/postings`;
    case 'remoteok': return 'https://remoteok.com/api';
    case 'remotive': return identifier && identifier !== 'remotive'
      ? `https://remotive.com/api/remote-jobs?category=${slug}`
      : 'https://remotive.com/api/remote-jobs';
    case 'arbeitnow': return 'https://www.arbeitnow.com/api/job-board-api';
    default: throw new Error(`Unsupported job feed kind: ${String(kind)}`);
  }
}

/** Accept header per kind, so a server can content-negotiate correctly. */
export function jobFeedAccept(kind: JobFeedKind): string {
  return kind === 'rss'
    ? 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8'
    : 'application/json';
}
