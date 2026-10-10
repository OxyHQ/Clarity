/**
 * Jibe career sites — the `/api/jobs` JSON that iCIMS-backed career sites on an
 * employer's own domain serve, full descriptions included, paged by number.
 * Classic `careers-*.icims.com` hosts are robots-disallowed and never used.
 *
 * Identifier: the career site host, e.g. `careers.mcafee.com`.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date, employmentTypes, get, json, listing, markdown, nextPageNumber, node, nodes, num, page, place, places, salary,
  strings, text, workplace,
} from '../listing.js';

const PAGE_SIZE = 100;

export const jibe: JobFeedProvider = {
  kind: 'jibe',
  identifier: { meaning: 'the career site host serving /api/jobs, e.g. careers.mcafee.com', shape: 'slug', pattern: /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/ },
  request: (identifier, cursor) => get(`https://${identifier}/api/jobs?page=${Number(cursor ?? 1) || 1}&limit=${PAGE_SIZE}`),
  parse(body, context) {
    const payload = node(json(body, 'jibe'));
    const jobs = nodes(payload['jobs']).map((entry) => node(entry['data']));
    const current = Number(context.cursor ?? 1) || 1;
    return page(jobs.map((job) => {
      const slug = text(job['slug']) ?? text(job['req_id']);
      return listing({
        title: text(job['title']),
        employerName: text(job['hiring_organization']) ?? context.label ?? context.identifier,
        canonicalUrl: slug ? `https://${context.identifier}/jobs/${encodeURIComponent(slug)}` : undefined,
        applyUrl: text(job['apply_url']),
        context,
        description: markdown(job['description']),
        responsibilities: markdown(job['responsibilities']),
        qualifications: markdown(job['qualifications']),
        employerLogoUrl: text(job['hiring_organization_logo']),
        locations: places([
          place({ locality: job['city'], region: job['state'], countryCode: job['country_code'], country: job['country'], postalCode: job['postal_code'], raw: job['location_name'] }),
          ...nodes(job['additional_locations']).map((entry) => place({ locality: entry['city'], region: entry['state'], countryCode: entry['country_code'], country: entry['country'] })),
        ]),
        workplaceType: workplace(strings(job['tags1'])[0]),
        employmentTypes: employmentTypes(job['employment_type']),
        salary: salary({ min: job['salary_min_value'], max: job['salary_max_value'], currency: job['salary_currency'], interval: job['salary_frequency'] }),
        occupationalCategory: strings(job['categories'])[0],
        identifier: text(job['req_id']),
        publishedAt: date(job['posted_date']),
        validThrough: date(job['posting_expiry_date']),
      });
    }), nextPageNumber(context.cursor, current * PAGE_SIZE < (num(payload['totalCount']) ?? 0)));
  },
};
