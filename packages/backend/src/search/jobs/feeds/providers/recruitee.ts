/**
 * Recruitee careers API — one company's published offers in a single response.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  employmentTypesIn, firstText, humanize, get, json, listing, markdown, node, nodes, page, place, places, salary,
  seniority, strings, text, date,
} from '../listing.js';

export const recruitee: JobFeedProvider = {
  kind: 'recruitee',
  identifier: { meaning: 'the company slug in <slug>.recruitee.com', shape: 'slug' },
  completeListing: true,
  request: (identifier) => get(`https://${encodeURIComponent(identifier)}.recruitee.com/api/offers/`),
  parse(body, context) {
    const payload = node(json(body, 'recruitee'));
    return page(nodes(payload['offers']).map((job) => {
      const pay = node(job['salary']);
      const remote = job['remote'] === true;
      const hybrid = job['hybrid'] === true;
      const onSite = job['on_site'] === true;
      return listing({
        title: text(job['title']),
        employerName: text(job['company_name']) ?? context.identifier,
        canonicalUrl: firstText(job['careers_url'], job['careers_apply_url']),
        applyUrl: text(job['careers_apply_url']),
        context,
        description: markdown(job['description']),
        qualifications: markdown(job['requirements']),
        locations: places([
          ...nodes(job['locations']).map((entry) => place({
            locality: entry['city'], region: entry['state'], country: entry['country'], countryCode: entry['country_code'],
            postalCode: entry['postal_code'],
          })),
          place({ locality: job['city'], region: job['state_name'], country: job['country'], countryCode: job['country_code'] }),
        ]),
        // Recruitee sets one flag per workplace option; only a single stated option is a workplace type.
        ...([remote, hybrid, onSite].filter(Boolean).length === 1
          ? { workplaceType: remote ? 'remote' as const : hybrid ? 'hybrid' as const : 'onsite' as const }
          : {}),
        employmentTypes: employmentTypesIn(job['employment_type_code']),
        seniority: seniority(job['experience_code']),
        salary: salary({ min: pay['min'], max: pay['max'], currency: pay['currency'], interval: pay['period'] }),
        skills: strings(job['tags'], 20),
        department: text(job['department']),
        // Recruitee's category is the employer's sector (`banking`, `energy`).
        industry: humanize(job['category_code']),
        identifier: job['id'] === undefined ? undefined : String(job['id']),
        publishedAt: date(job['published_at'] ?? job['created_at']),
        validThrough: date(job['close_at']),
      });
    }));
  },
};
