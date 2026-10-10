/**
 * AI Dev Jobs (aidevboard.com) — AI/ML roles, paged by page number. The board
 * orders by its own listing-quality score rather than by date, so coverage
 * comes from the backfill walk; 200 requests an hour are allowed anonymously.
 *
 * `is_featured`, `is_sticky` and `quality_score` are the board's promotion and
 * ranking signals and are never read.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date, employmentTypes, get, json, listing, locationText, markdown, nextPageNumber, node, nodes, page, places,
  salary, seniority, strings, text, workplace, withQuery,
} from '../listing.js';

export const aidevboard: JobFeedProvider = {
  kind: 'aidevboard',
  identifier: { meaning: 'unused; leave it as the kind name', shape: 'none' },
  request: (_identifier, cursor) => get(withQuery('https://aidevboard.com/api/v1/jobs', { limit: 50, page: cursor ?? 1 })),
  terms: 'Data may be used in applications but not resold as a standalone dataset; 200 anonymous requests per hour.',
  parse(body, context) {
    const payload = node(json(body, 'aidevboard'));
    return page(nodes(payload['jobs']).map((job) => listing({
      title: text(job['title']),
      employerName: text(job['company_name']),
      canonicalUrl: text(job['url']),
      applyUrl: text(job['apply_url']),
      context,
      description: markdown(job['description']),
      employerLogoUrl: text(job['company_logo_url']),
      locations: places(locationText(text(job['location']))),
      workplaceType: workplace(job['workplace']),
      employmentTypes: employmentTypes(job['job_type']),
      seniority: seniority(job['experience_level']),
      // The API documents both bounds as USD per year.
      salary: salary({ min: job['salary_min'], max: job['salary_max'], currency: 'USD', interval: 'year' }),
      skills: strings(job['tags'], 20),
      identifier: text(job['id']),
      publishedAt: date(job['published_at'] ?? job['created_at']),
      validThrough: date(job['expires_at']),
    })), nextPageNumber(context.cursor, payload['has_next'] === true));
  },
};
