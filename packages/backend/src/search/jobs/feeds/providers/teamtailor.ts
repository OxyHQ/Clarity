/**
 * Teamtailor JSON Feed — one company's public jobs in one response, each item
 * carrying the board's own `schema.org/JobPosting`, which goes through the
 * shared extractor unchanged. Many boards opt out of search with
 * `Content-Signal: search=no`; the poller honours that per board.
 */
import { extractJobPostings } from '../../extract.js';
import type { JobFeedProvider } from '../provider.js';
import { get, json, node, nodes, page, text } from '../listing.js';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const teamtailor: JobFeedProvider = {
  kind: 'teamtailor',
  identifier: {
    meaning: 'the company subdomain in <company>.teamtailor.com',
    shape: 'slug',
    pattern: DNS_LABEL,
  },
  completeListing: true,
  request: (identifier) => get(`https://${identifier}.teamtailor.com/jobs.json`),
  parse(body, context) {
    const payload = node(json(body, 'teamtailor'));
    return page(
      nodes(payload.items).map((item) => {
        const posting = node(item._jobposting);
        const url = text(item.url);
        if (!url || Object.keys(posting).length === 0) return undefined;
        const [extracted] = extractJobPostings(
          [
            {
              ...posting,
              '@type': 'JobPosting',
              url,
              description: posting.description ?? item.content_html,
              datePosted: posting.datePosted ?? item.date_published,
            },
          ],
          url,
          context.extractedAt,
          'feed',
        );
        return extracted;
      }),
    );
  },
};
