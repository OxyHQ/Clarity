/**
 * Arbeitnow job board API — European and remote listings, newest first, paged
 * by page number.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  employmentTypes,
  epochSeconds,
  get,
  json,
  listing,
  locationText,
  markdown,
  nextPageNumber,
  node,
  nodes,
  page,
  places,
  strings,
  text,
  withQuery,
  date,
} from '../listing.js';

export const arbeitnow: JobFeedProvider = {
  kind: 'arbeitnow',
  identifier: { meaning: 'unused; leave it as the kind name', shape: 'none' },
  completeListing: true,
  request: (_identifier, cursor) =>
    get(withQuery('https://www.arbeitnow.com/api/job-board-api', { page: cursor })),
  terms: 'Free public API; link back to Arbeitnow.',
  parse(body, context) {
    const payload = node(json(body, 'arbeitnow'));
    const jobs = nodes(payload['data']);
    const links = node(payload['links']);
    return page(
      jobs.map((job) =>
        listing({
          title: text(job['title']),
          employerName: text(job['company_name']),
          canonicalUrl: text(job['url']),
          context,
          description: markdown(job['description']),
          locations: places(locationText(text(job['location']))),
          ...(job['remote'] === true ? { workplaceType: 'remote' as const } : {}),
          employmentTypes: employmentTypes(job['job_types']),
          skills: strings(job['tags'], 20),
          identifier: text(job['slug']),
          publishedAt: epochSeconds(job['created_at']) ?? date(job['created_at']),
        }),
      ),
      nextPageNumber(context.cursor, jobs.length > 0 && typeof links['next'] === 'string'),
    );
  },
};
