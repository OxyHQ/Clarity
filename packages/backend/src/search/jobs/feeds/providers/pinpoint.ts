/**
 * Pinpoint postings JSON — one company's public postings in one response, with
 * the description split into the sections the board shows.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date, employmentTypesIn, get, json, listing, markdown, node, nodes, page, place, places, salary, text,
  workplace,
} from '../listing.js';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const pinpoint: JobFeedProvider = {
  kind: 'pinpoint',
  identifier: { meaning: 'the company subdomain in <company>.pinpointhq.com', shape: 'slug', pattern: DNS_LABEL },
  request: (identifier) => get(`https://${identifier}.pinpointhq.com/postings.json`),
  parse(body, context) {
    const payload = node(json(body, 'pinpoint'));
    return page(nodes(payload['data']).map((job) => {
      const where = node(job['location']);
      const role = node(job['job']);
      return listing({
        title: text(job['title']),
        employerName: context.label ?? context.identifier,
        canonicalUrl: text(job['url']),
        context,
        description: markdown(job['description']),
        responsibilities: markdown(job['key_responsibilities']),
        qualifications: markdown(job['skills_knowledge_expertise']),
        benefits: markdown(job['benefits']),
        locations: places([place({
          locality: where['city'], region: where['province'], postalCode: where['postal_code'], raw: where['name'],
        })]),
        workplaceType: workplace(job['workplace_type']),
        employmentTypes: employmentTypesIn(job['employment_type'], job['employment_type_text']),
        // Pay counts only where the employer chose to show it.
        salary: job['compensation_visible'] === true ? salary({
          min: job['compensation_minimum'], max: job['compensation_maximum'],
          currency: job['compensation_currency'], interval: job['compensation_frequency'],
        }) : undefined,
        department: text(node(role['department'])['name']),
        identifier: text(role['requisition_id']) ?? text(job['id']),
        validThrough: date(job['deadline_at']),
      });
    }));
  },
};
