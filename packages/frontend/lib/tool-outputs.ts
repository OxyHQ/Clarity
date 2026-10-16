/**
 * What Clarity's catalogue tools returned, read for drawing.
 *
 * Each `clarity:<tool>` renderer in the chat (`components/chat/clarity-tool-renderers.tsx`)
 * receives the tool's structured output, which is byte for byte what the matching HTTP route
 * answers (`POST /v1/search`, `GET /news`, `POST /jobs/search`, `GET /market/quotes`, …). These
 * readers keep only the entries a card can actually draw, so a malformed or partial output draws
 * nothing rather than a broken card. Pure: nothing here loads React Native.
 */

import type { JobPosting, MarketQuoteResult, NewsStory } from '@clarity/shared-types';

import type { Source } from './sources';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** A search result or document (`canonicalUrl`, `title`, `snippet` | `description`) as a link. */
export function sourceOfDocument(value: unknown): Source | null {
  if (!isRecord(value) || !nonEmpty(value.canonicalUrl)) return null;
  const url = value.canonicalUrl;
  const domain = domainOf(url);
  const excerpt = nonEmpty(value.snippet)
    ? value.snippet
    : nonEmpty(value.description)
      ? value.description
      : '';
  return {
    title: nonEmpty(value.title) ? value.title : domain,
    url,
    snippet: excerpt.slice(0, 200),
    domain,
  };
}

/** The pages of a `search` output (`{ data: SearchResult[] }`), in rank order. */
export function sourcesOfSearch(output: unknown): Source[] {
  if (!isRecord(output) || !Array.isArray(output.data)) return [];
  return output.data.flatMap((result) => sourceOfDocument(result) ?? []);
}

/** The stories of a `listNews` output (`{ data: NewsStory[] }`) a card can draw. */
export function storiesOfNews(output: unknown): NewsStory[] {
  if (!isRecord(output) || !Array.isArray(output.data)) return [];
  return output.data.filter(
    (story): story is NewsStory =>
      isRecord(story) &&
      nonEmpty(story.id) &&
      nonEmpty(story.title) &&
      Array.isArray(story.articles) &&
      typeof story.sourceCount === 'number',
  );
}

function isJob(value: unknown): value is JobPosting & { snippet?: string } {
  return (
    isRecord(value) &&
    nonEmpty(value.id) &&
    nonEmpty(value.title) &&
    isRecord(value.employer) &&
    nonEmpty(value.employer.name) &&
    isRecord(value.source) &&
    nonEmpty(value.source.domain) &&
    Array.isArray(value.locations) &&
    Array.isArray(value.employmentTypes) &&
    Array.isArray(value.otherSources)
  );
}

/** The postings of a `searchJobs` output (`{ data: JobSearchResult[] }`), in rank order. */
export function jobsOfSearch(output: unknown): Array<JobPosting & { snippet?: string }> {
  if (!isRecord(output) || !Array.isArray(output.data)) return [];
  return output.data.filter(isJob);
}

/** The one posting of a `getJob` / `getJobByUrl` output, or null. */
export function jobOf(output: unknown): JobPosting | null {
  return isJob(output) ? output : null;
}

/** Each requested asset's outcome in a `getMarketQuotes` output (`{ results }`). */
export function quotesOf(output: unknown): MarketQuoteResult[] {
  if (!isRecord(output) || !Array.isArray(output.results)) return [];
  return output.results.filter(
    (result): result is MarketQuoteResult =>
      isRecord(result) &&
      nonEmpty(result.requested) &&
      ((result.status === 'quoted' && isRecord(result.quote)) ||
        (result.status === 'unavailable' && isRecord(result.error))),
  );
}

/** How many of `total` a preview of `max` leaves unshown — said, never hidden. */
export function unshownCount(total: number, max: number): number {
  return Math.max(0, total - max);
}
