/**
 * SmartRecruiters posting API — one company's public postings, paged by
 * offset (at most 100 per page).
 *
 * A posting's `ref` is its API URL, not a page anyone can open, so the public
 * listing URL is built from the company identifier and posting id the way the
 * hosted board links it.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  employmentTypes, get, json, listing, nextOffset, node, nodes, num, page, place, places, seniority, text,
  withQuery, date,
} from '../listing.js';

const PAGE_SIZE = 100;

export const smartrecruiters: JobFeedProvider = {
  kind: 'smartrecruiters',
  identifier: { meaning: 'the company identifier in careers.smartrecruiters.com/<company>', shape: 'slug' },
  completeListing: true,
  request: (identifier, cursor) => get(withQuery(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(identifier)}/postings`,
    { limit: PAGE_SIZE, offset: cursor ?? 0 },
  )),
  parse(body, context) {
    const payload = node(json(body, 'smartrecruiters'));
    const content = nodes(payload['content']);
    return page(content.map((job) => {
      const where = node(job['location']);
      const company = node(job['company']);
      const companyId = text(company['identifier']) ?? context.identifier;
      const id = text(job['id']);
      return listing({
        title: text(job['name']),
        employerName: text(company['name']) ?? context.identifier,
        canonicalUrl: id ? `https://jobs.smartrecruiters.com/${encodeURIComponent(companyId)}/${encodeURIComponent(id)}` : undefined,
        context,
        locations: places([place({
          locality: where['city'], region: where['region'], countryCode: where['country'], postalCode: where['postalCode'],
          raw: where['fullLocation'],
        })]),
        workplaceType: where['remote'] === true ? 'remote' : where['hybrid'] === true ? 'hybrid' : undefined,
        employmentTypes: employmentTypes(node(job['typeOfEmployment'])['label'], node(job['typeOfEmployment'])['id']),
        seniority: seniority(node(job['experienceLevel'])['id'], node(job['experienceLevel'])['label']),
        industry: text(node(job['industry'])['label']),
        occupationalCategory: text(node(job['function'])['label']),
        department: text(node(job['department'])['label']),
        identifier: id,
        publishedAt: date(job['releasedDate']),
      });
    }), nextOffset(context.cursor, content.length, PAGE_SIZE, num(payload['totalFound'])));
  },
};
