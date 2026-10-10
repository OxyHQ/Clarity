/**
 * Remotive public API — remote listings in a single response, delayed 24h by
 * Remotive. Its notice asks for at most four requests a day and for the
 * Remotive listing URL to be linked as the source, which is the canonical URL
 * here.
 */
import type { JobFeedProvider } from '../provider.js';
import { employmentTypes, get, json, listing, markdown, node, nodes, page, strings, text, date } from '../listing.js';

export const remotive: JobFeedProvider = {
  kind: 'remotive',
  identifier: { meaning: 'unused, or a category slug', shape: 'optional' },
  request: (identifier) => get(identifier && identifier !== 'remotive'
    ? `https://remotive.com/api/remote-jobs?category=${encodeURIComponent(identifier)}`
    : 'https://remotive.com/api/remote-jobs'),
  minPollIntervalSeconds: 6 * 60 * 60,
  terms: 'Link back to the Remotive listing URL and mention Remotive as the source; poll at most four times a day.',
  parse(body, context) {
    const payload = node(json(body, 'remotive'));
    return page(nodes(payload['jobs']).map((job) => listing({
      title: text(job['title']),
      employerName: text(job['company_name']),
      canonicalUrl: text(job['url']),
      context,
      description: markdown(job['description']),
      employerLogoUrl: text(job['company_logo']) ?? text(job['company_logo_url']),
      // Remotive's `salary` is free text ("$50-$75/hour", "competitive") with
      // no separate currency, bounds or interval — nothing structured to keep.
      applicantLocationRequirements: typeof job['candidate_required_location'] === 'string'
        ? job['candidate_required_location'].split(',').map((item) => item.trim()).filter(Boolean) : [],
      workplaceType: 'remote',
      employmentTypes: employmentTypes(job['job_type']),
      skills: strings(job['tags'], 20),
      occupationalCategory: text(job['category']),
      identifier: job['id'] === undefined ? undefined : String(job['id']),
      publishedAt: date(job['publication_date']),
    })));
  },
};
