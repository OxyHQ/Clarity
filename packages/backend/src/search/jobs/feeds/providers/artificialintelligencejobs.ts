/**
 * artificialintelligencejobs.co — AI/ML roles from company career pages,
 * newest first, paged by offset (at most 200). The API carries no
 * description; each listing links to the board's page and the employer's
 * application URL.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date, get, json, listing, locationText, nextOffset, node, nodes, num, page, places, salaryText, seniority, text,
  withQuery, DOLLAR_BY_COUNTRY,
} from '../listing.js';

const PAGE_SIZE = 200;

export const artificialintelligencejobs: JobFeedProvider = {
  kind: 'artificialintelligencejobs',
  identifier: { meaning: 'unused; leave it as the kind name', shape: 'none' },
  request: (_identifier, cursor) => get(withQuery('https://artificialintelligencejobs.co/api/jobs', { limit: PAGE_SIZE, offset: cursor ?? 0 })),
  terms: 'Attribution appreciated (link to artificialintelligencejobs.co); no bulk scraping that degrades the service.',
  parse(body, context) {
    const payload = node(json(body, 'artificialintelligencejobs'));
    const jobs = nodes(payload['jobs']);
    return page(jobs.map((job) => {
      const located = places(locationText(text(job['location'])));
      const country = located[0]?.countryCode ?? (text(job['region']) === 'US' ? 'US' : undefined);
      return listing({
        title: text(job['title']),
        employerName: text(job['company']),
        canonicalUrl: text(job['url']),
        applyUrl: text(job['apply_url']),
        context,
        locations: located,
        ...(job['remote'] === true ? { workplaceType: 'remote' as const } : {}),
        seniority: seniority(job['level']),
        salary: salaryText(job['salary'], { dollar: country ? DOLLAR_BY_COUNTRY[country] : undefined }),
        occupationalCategory: text(job['category']),
        publishedAt: date(job['posted']),
      });
    }), nextOffset(context.cursor, jobs.length, PAGE_SIZE, num(payload['matched'])));
  },
};
