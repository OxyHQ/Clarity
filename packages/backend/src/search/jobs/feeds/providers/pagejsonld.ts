/**
 * Reading a linked posting page through its own `schema.org/JobPosting`, for
 * sources whose feed only names the page.
 */
import { extractJobPostings } from '../../extract.js';
import type { JobFeedListingPage } from '../provider.js';
import { jsonLdBlocks } from '../listing.js';

/** Tracking parameters a feed appends to its links; the posting's own URL is the page without them. */
const TRACKING = /^(?:utm_[a-z]+|trackid|ref|source|src|sid|origin)$/i;

export function withoutTracking(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()])
      if (TRACKING.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return value;
  }
}

export const jsonLdPage: JobFeedListingPage = {
  parse(html, reference, context) {
    const [posting] = extractJobPostings(
      jsonLdBlocks(html),
      reference.url,
      context.extractedAt,
      'feed',
    );
    // The page is the listing: its own URL is canonical whatever the JSON-LD says.
    return posting
      ? { ...posting, canonicalUrl: reference.url, applyUrl: posting.applyUrl ?? reference.url }
      : undefined;
  },
};
