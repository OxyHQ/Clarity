/**
 * Hireology careers API — one organization's (or group's) public jobs with
 * full descriptions, up to 500 a page. Hireology states pay without a
 * currency, so pay is not read; its third-party integration data (which holds
 * service tokens) is never read either.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date, employmentTypesIn, get, json, listing, markdown, nextPageNumber, node, nodes, num, page, place, places, text,
} from '../listing.js';

const PAGE_SIZE = 500;

export const hireology: JobFeedProvider = {
  kind: 'hireology',
  identifier: { meaning: 'the career site slug in careers.hireology.com/<slug>', shape: 'slug', pattern: /^[a-z0-9][a-z0-9-]{0,100}$/ },
  request: (identifier, cursor) => get(`https://api.hireology.com/v2/public/careers/${encodeURIComponent(identifier)}?page_size=${PAGE_SIZE}&page=${Number(cursor ?? 1) || 1}`),
  parse(body, context) {
    const payload = node(json(body, 'hireology'));
    const jobs = nodes(payload['data']);
    const current = Number(context.cursor ?? 1) || 1;
    const total = num(payload['count']) ?? 0;
    return page(jobs.map((job) => {
      const path = text(job['career_site_path']);
      return listing({
        title: text(job['name']),
        employerName: text(node(job['organization'])['name']) ?? context.label ?? context.identifier,
        canonicalUrl: path ? `https://careers.hireology.com${path.startsWith('/') ? '' : '/'}${path}` : undefined,
        context,
        description: markdown(job['job_description']),
        locations: places(nodes(job['locations']).map((entry) => place({ locality: entry['city'], region: entry['state'], postalCode: entry['zip_code'] }))),
        ...(job['remote'] === true ? { workplaceType: 'remote' as const } : {}),
        employmentTypes: employmentTypesIn(job['employment_status']),
        occupationalCategory: text(node(job['job_family'])['name']),
        identifier: text(job['id']),
        publishedAt: date(job['created_at']),
      });
    }), nextPageNumber(context.cursor, current * PAGE_SIZE < total));
  },
};
