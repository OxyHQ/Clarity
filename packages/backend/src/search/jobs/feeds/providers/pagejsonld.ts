/**
 * Reading a linked posting page through its own `schema.org/JobPosting`, for
 * sources whose feed only names the page.
 */
import { extractJobPostings } from '../../extract.js';
import type { JobFeedListingPage } from '../provider.js';
import { jsonLdBlocks } from '../listing.js';

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
