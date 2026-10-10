/**
 * Madgex job boards (The Chronicle of Higher Education, Science Careers,
 * Guardian Jobs, …) — the board's RSS lists postings newest first, 20 a page,
 * and each posting page carries the full `schema.org/JobPosting`.
 *
 * Identifier: the board host, e.g. `jobs.chronicle.com`.
 */
import type { JobFeedProvider } from '../provider.js';
import { XML_ACCEPT, date, elements, get, num, tag, text } from '../listing.js';
import { jsonLdPage, withoutTracking } from './pagejsonld.js';

const PAGE_SIZE = 20;

export const madgex: JobFeedProvider = {
  kind: 'madgex',
  identifier: { meaning: 'the host of a Madgex job board serving /jobsrss/, e.g. jobs.chronicle.com', shape: 'slug', pattern: /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/ },
  request: (identifier, cursor) => get(`https://${identifier}/jobsrss/?page=${Number(cursor ?? 1) || 1}`, XML_ACCEPT),
  parse(body, context) {
    const items = elements(body, 'item');
    const current = Number(context.cursor ?? 1) || 1;
    const total = num(text(tag(body, 'opensearch:totalResults'))) ?? 0;
    return {
      listings: [],
      references: items.flatMap((item) => {
        const link = text(tag(item, 'link'));
        const published = date(text(tag(item, 'pubDate')));
        return link ? [{ url: withoutTracking(link), ...(published ? { lastModified: published } : {}) }] : [];
      }),
      ...(items.length === PAGE_SIZE && current * PAGE_SIZE < total ? { nextCursor: String(current + 1) } : {}),
    };
  },
  listingPage: jsonLdPage,
};
