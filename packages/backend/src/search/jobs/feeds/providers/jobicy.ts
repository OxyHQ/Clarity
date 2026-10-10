/**
 * Jobicy remote jobs API — the last seven days of remote listings, newest
 * first, followed by cursor. Jobicy asks to stay credited through its own
 * listing URL (the canonical URL here) and to start a sync at most hourly.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date,
  employmentTypes,
  get,
  json,
  listing,
  markdown,
  node,
  nodes,
  page,
  salary,
  seniority,
  strings,
  text,
  withQuery,
} from '../listing.js';

export const jobicy: JobFeedProvider = {
  kind: 'jobicy',
  identifier: { meaning: 'unused; leave it as the kind name', shape: 'none' },
  request: (_identifier, cursor) =>
    get(withQuery('https://jobicy.com/api/v2/remote-jobs', { count: 200, cursor })),
  minPollIntervalSeconds: 60 * 60,
  terms:
    'Keep Jobicy as the original source and preserve the canonical Jobicy job URL; sync at most once an hour.',
  parse(body, context) {
    const payload = node(json(body, 'jobicy'));
    return page(
      nodes(payload['jobs']).map((job) => {
        const geo = text(job['jobGeo']);
        return listing({
          title: text(job['jobTitle']),
          employerName: text(job['companyName']),
          canonicalUrl: text(job['url']),
          context,
          description: markdown(job['jobDescription']),
          employerLogoUrl: text(job['companyLogo']),
          workplaceType: 'remote',
          applicantLocationRequirements:
            geo && geo.toLowerCase() !== 'anywhere' ? strings(geo) : [],
          employmentTypes: employmentTypes(job['jobType']),
          seniority: seniority(...(text(job['jobLevel'])?.split(',') ?? [])),
          salary: salary({
            min: job['salaryMin'],
            max: job['salaryMax'],
            currency: job['salaryCurrency'],
            interval: job['salaryPeriod'],
          }),
          occupationalCategory: strings(job['jobIndustry'])[0],
          identifier: text(job['id']),
          publishedAt: date(job['pubDate']),
        });
      }),
      payload['hasMore'] === true ? text(payload['nextCursor']) : undefined,
    );
  },
};
