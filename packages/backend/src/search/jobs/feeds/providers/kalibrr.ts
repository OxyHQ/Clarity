/**
 * Kalibrr (Philippines, Indonesia) — a company's jobs through the board's
 * public search, always filtered to that company. Each job states its
 * description, address, workplace flags, function and application deadline.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date, employmentTypesIn, get, json, listing, markdown, nextOffset, node, nodes, num, page, place, places, text, withQuery,
} from '../listing.js';

const PAGE_SIZE = 50;

export const kalibrr: JobFeedProvider = {
  kind: 'kalibrr',
  identifier: { meaning: 'the company code in kalibrr.com/c/<code>/jobs', shape: 'slug', pattern: /^[a-z0-9][a-z0-9-]{0,80}$/ },
  completeListing: true,
  request: (identifier, cursor) => get(withQuery('https://www.kalibrr.com/kjs/job_board/search', { limit: PAGE_SIZE, offset: Number(cursor ?? 0) || 0, company: identifier })),
  parse(body, context) {
    const payload = node(json(body, 'kalibrr'));
    const jobs = nodes(payload['jobs']);
    return page(jobs.map((job) => {
      const company = node(job['company_info']);
      const code = text(node(job['company'])['code']) ?? context.identifier;
      const id = text(job['id']);
      const slug = text(job['slug']);
      // Kalibrr's search does not honour the filter for every company; only this company's jobs belong to the feed.
      if (code !== context.identifier) return undefined;
      const address = node(node(job['google_location'])['address_components']);
      return listing({
        title: text(job['name']),
        employerName: text(company['name']) ?? text(job['company_name']),
        canonicalUrl: id && slug ? `https://www.kalibrr.com/c/${encodeURIComponent(code)}/jobs/${encodeURIComponent(id)}/${encodeURIComponent(slug)}` : undefined,
        context,
        description: markdown(job['description']),
        qualifications: markdown(job['qualifications']),
        employerUrl: text(company['url']),
        employerLogoUrl: text(company['logo']),
        locations: places([place({ locality: address['city'], region: address['region'], country: address['country'] })]),
        workplaceType: job['is_work_from_home'] === true ? 'remote' : job['is_hybrid'] === true ? 'hybrid' : undefined,
        employmentTypes: employmentTypesIn(job['tenure']),
        industry: text(company['industry']),
        occupationalCategory: text(job['function']),
        identifier: id,
        publishedAt: date(job['activation_date']),
        validThrough: date(job['application_end_date']),
      });
    }), nextOffset(context.cursor, jobs.length, PAGE_SIZE, num(payload['count'])));
  },
};
