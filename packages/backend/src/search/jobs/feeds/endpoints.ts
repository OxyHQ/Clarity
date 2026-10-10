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

import type { JobFeedRequest } from './provider.js';
import { JOB_FEED_PROVIDERS, jobFeedProvider } from './registry.js';

/** Non-empty, in registry order, so it can back a `z.enum` directly. */
export const JOB_FEED_KINDS = Object.keys(JOB_FEED_PROVIDERS) as [JobFeedKind, ...JobFeedKind[]];

/** How a kind's `identifier` column is interpreted, for operators and errors. */
export const JOB_FEED_IDENTIFIER_MEANING: Readonly<Record<JobFeedKind, string>> = Object.freeze(
  Object.fromEntries(JOB_FEED_KINDS.map((kind) => [kind, JOB_FEED_PROVIDERS[kind].identifier.meaning])) as Record<JobFeedKind, string>,
);

const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/;

/**
 * Validates an identifier for its kind. Throws rather than guessing, so a
 * malformed identifier fails at registration instead of quietly fetching the
 * wrong board.
 */
export function assertJobFeedIdentifier(kind: JobFeedKind, identifier: string): void {
  const { identifier: rule } = jobFeedProvider(kind);
  if (rule.shape === 'url') {
    const parsed = new URL(identifier);
    if (parsed.protocol !== 'https:') throw new Error('An RSS feed identifier must be an https URL');
    if (parsed.username || parsed.password) throw new Error('A feed URL may not carry credentials');
    return;
  }
  if (rule.shape === 'none') return;
  if (rule.shape === 'optional' && (identifier === '' || identifier === kind)) return;
  if (!(rule.pattern ?? SLUG).test(identifier)) throw new Error(`Identifier for ${kind} must be ${rule.meaning}`);
}

/** The request for one page of a feed; `cursor` is absent for the newest page. */
export function jobFeedRequest(kind: JobFeedKind, identifier: string, cursor?: string): JobFeedRequest {
  assertJobFeedIdentifier(kind, identifier);
  return jobFeedProvider(kind).request(identifier, cursor);
}

/** The URL of a feed's first page. */
export function jobFeedUrl(kind: JobFeedKind, identifier: string): string {
  return jobFeedRequest(kind, identifier).url;
}

/** The shortest poll interval a kind's published terms allow. */
export function jobFeedMinPollIntervalSeconds(kind: JobFeedKind): number {
  return jobFeedProvider(kind).minPollIntervalSeconds ?? 900;
}
