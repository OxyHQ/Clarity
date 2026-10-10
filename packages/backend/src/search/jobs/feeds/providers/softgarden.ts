/**
 * softgarden — each career site's `jobs.feed.json`, a schema.org DataFeed of
 * complete `JobPosting`s, read through the shared extractor unchanged.
 */
import { extractJobPostings } from '../../extract.js';
import type { JobFeedProvider } from '../provider.js';
import { get, json, node, nodes, page, text } from '../listing.js';

export const softgarden: JobFeedProvider = {
  kind: 'softgarden',
  identifier: {
    meaning: 'the subdomain in <sub>.career.softgarden.de',
    shape: 'slug',
    pattern: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  },
  completeListing: true,
  request: (identifier) => get(`https://${identifier}.career.softgarden.de/jobs.feed.json`),
  maxBodyBytes: 40 * 1024 * 1024,
  parse(body, context) {
    const feed = node(json(body, 'softgarden'));
    return page(
      nodes(feed.dataFeedElement).map((element) => {
        const posting = node(element.item);
        const url = text(posting.url);
        if (!url) return undefined;
        const [extracted] = extractJobPostings(
          [{ ...posting, '@type': 'JobPosting' }],
          url,
          context.extractedAt,
          'feed',
        );
        return extracted;
      }),
    );
  },
};
