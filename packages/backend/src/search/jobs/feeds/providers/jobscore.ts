/**
 * JobScore — each company's public `feed.json`, every open job with full
 * description, structured location and pay (in cents). The hiring team is
 * never read; the apply flow is robots-disallowed and only linked.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date,
  employmentTypesIn,
  get,
  json,
  listing,
  markdown,
  node,
  nodes,
  num,
  page,
  place,
  places,
  salary,
  seniority,
  text,
} from '../listing.js';
import { withoutTracking } from './pagejsonld.js';

export const jobscore: JobFeedProvider = {
  kind: 'jobscore',
  identifier: {
    meaning: 'the company code in careers.jobscore.com/careers/<company>',
    shape: 'slug',
    pattern: /^[a-z0-9][a-z0-9_-]{0,80}$/,
  },
  completeListing: true,
  request: (identifier) =>
    get(`https://careers.jobscore.com/jobs/${encodeURIComponent(identifier)}/feed.json`),
  parse(body, context) {
    const payload = node(json(body, 'jobscore'));
    return page(
      nodes(payload['jobs']).map((job) => {
        const remote = text(job['remote']);
        const cents = (value: unknown) => {
          const amount = num(value);
          return amount === undefined ? undefined : amount / 100;
        };
        return listing({
          title: text(job['title']),
          employerName: text(job['company_name']) ?? text(payload['company_name']),
          canonicalUrl: withoutTracking(text(job['detail_url']) ?? ''),
          applyUrl: text(job['apply_url']),
          context,
          description: markdown(job['description']),
          employerUrl: text(payload['company_url']),
          locations: places([
            place({
              locality: job['city'],
              region: job['state'],
              countryCode: job['country'],
              postalCode: job['postal_code'],
              raw: job['location'],
            }),
          ]),
          // "Yes | Can telecommute / work remotely 100% of the time" states remote; anything else does not.
          ...(remote && /^yes\b/i.test(remote) ? { workplaceType: 'remote' as const } : {}),
          employmentTypes: employmentTypesIn(job['job_type']),
          seniority: seniority(text(job['experience_level'])?.split(/[\s(]/)[0]),
          salary: salary({
            min: cents(job['public_salary_minimum']),
            max: cents(job['public_salary_maximum']),
            currency: job['currency_code'],
            interval: text(job['public_compensation_interval'])?.replace(/^per\s+/i, ''),
          }),
          department: text(job['department']),
          identifier: text(job['id']),
          publishedAt: date(job['opened_date'] ?? job['created_on']),
        });
      }),
    );
  },
};
