/**
 * Turning each public source's payload into Clarity's normalized listings.
 *
 * Each provider (`providers/<kind>.ts`) owns its own mapping; every mapping is
 * built from the same helpers (`listing.ts`), so a field the source did not
 * state is ABSENT, never inferred. Where a provider ships
 * `schema.org/JobPosting` JSON-LD inside its payload it is parsed with the SAME
 * extractor a crawl uses, so a listing reaching Clarity through a feed and the
 * same listing reaching it through a crawl normalize identically and
 * deduplicate against each other.
 */
import type { JobFeedKind } from '@clarity/shared-types';

import type { ExtractedJobPosting } from '../extract.js';
import type { JobFeedContext, JobFeedPage } from './provider.js';
import { jobFeedProvider } from './registry.js';

export type { JobFeedContext as FeedContext } from './provider.js';

/** Parses one page of a feed into normalized listings and, when there is one, the next page's cursor. */
export function parseJobFeedPage(
  kind: JobFeedKind,
  body: string,
  context: JobFeedContext,
): JobFeedPage {
  return jobFeedProvider(kind).parse(body, context);
}

/** Parses one feed body into normalized listings. */
export function parseJobFeed(
  kind: JobFeedKind,
  body: string,
  context: JobFeedContext,
): ExtractedJobPosting[] {
  return parseJobFeedPage(kind, body, context).listings;
}
