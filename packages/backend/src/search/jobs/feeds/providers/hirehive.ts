/**
 * HireHive (Ireland, US) — each company's public jobs API, paged, with full
 * HTML descriptions, ISO country, experience and compensation tiers.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date,
  employmentTypes,
  get,
  json,
  listing,
  markdown,
  nextPageNumber,
  node,
  nodes,
  page,
  place,
  places,
  salary,
  seniority,
  text,
} from '../listing.js';

export const hirehive: JobFeedProvider = {
  kind: 'hirehive',
  identifier: {
    meaning: 'the subdomain in <sub>.hirehive.com',
    shape: 'slug',
    pattern: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  },
  completeListing: true,
  request: (identifier, cursor) =>
    get(
      `https://${identifier}.hirehive.com/api/v2/jobs?page=${Number(cursor ?? 1) || 1}&page_size=100`,
    ),
  parse(body, context) {
    const payload = node(json(body, 'hirehive'));
    const meta = node(payload['meta']);
    return page(
      nodes(payload['items']).map((job) => {
        const [tier] = nodes(job['compensation_tiers']).filter((entry) => entry['type'] !== 'none');
        return listing({
          title: text(job['title']),
          employerName: context.label ?? context.identifier,
          canonicalUrl: text(job['hosted_url']),
          context,
          description: markdown(
            node(job['description'])['html'] ?? node(job['description'])['text'],
          ),
          locations: places([
            place({
              locality: job['location'],
              region: job['state_code'],
              countryCode: node(job['country'])['code'],
              country: node(job['country'])['name'],
            }),
          ]),
          employmentTypes: employmentTypes(node(job['type'])['type'], node(job['type'])['name']),
          seniority: seniority(node(job['experience'])['name']),
          salary: tier
            ? salary({
                min: tier['min'],
                max: tier['max'],
                currency: tier['currency'],
                interval: tier['interval'],
              })
            : undefined,
          identifier: text(job['id']),
          publishedAt: date(job['published_date']),
        });
      }),
      nextPageNumber(context.cursor, meta['has_next_page'] === true),
    );
  },
};
