/**
 * Workable widget API — one account's public jobs in a single response.
 * `details=true` adds the description and the structured requirement fields.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  employmentTypes, firstText, get, json, listing, markdown, node, nodes, page, place, places, seniority,
  text, workplace, date,
} from '../listing.js';

export const workable: JobFeedProvider = {
  kind: 'workable',
  identifier: { meaning: 'the account slug in apply.workable.com/<slug>', shape: 'slug' },
  request: (identifier) => get(
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(identifier)}?details=true`,
  ),
  parse(body, context) {
    const payload = node(json(body, 'workable'));
    const employer = text(payload['name']) ?? context.identifier;
    return page(nodes(payload['jobs']).map((job) => listing({
      title: text(job['title']),
      employerName: employer,
      canonicalUrl: firstText(job['url'], job['shortlink'], job['application_url']),
      applyUrl: text(job['application_url']),
      context,
      description: markdown(job['description']),
      locations: places([
        ...nodes(job['locations']).map((entry) => place({
          locality: entry['city'], region: entry['region'], country: entry['country'], countryCode: entry['countryCode'],
        })),
        place({ locality: job['city'], region: job['state'], country: job['country'] }),
      ]),
      ...(job['telecommuting'] === true ? { workplaceType: 'remote' as const } : {}),
      employmentTypes: employmentTypes(job['employment_type']),
      seniority: seniority(job['experience']),
      educationRequirements: text(job['education']),
      industry: text(job['industry']),
      occupationalCategory: text(job['function']),
      department: text(job['department']),
      identifier: typeof job['shortcode'] === 'string' ? job['shortcode'] : undefined,
      publishedAt: date(job['published_on'] ?? job['created_at']),
    })));
  },
  // The widget states the description only; a posting's own record adds the
  // requirements and benefits sections and the stated workplace.
  detail: {
    request: (posting, identifier) => posting.identifier
      ? get(`https://apply.workable.com/api/v2/accounts/${encodeURIComponent(identifier)}/jobs/${encodeURIComponent(posting.identifier)}`)
      : undefined,
    parse(body, posting, context) {
      const job = node(json(body, 'workable'));
      if (text(job['state']) && text(job['state']) !== 'published') return undefined;
      return listing({
        ...posting,
        context,
        description: markdown(job['description']) ?? posting.description,
        qualifications: markdown(job['requirements']),
        benefits: markdown(job['benefits']),
        workplaceType: workplace(job['workplace']) ?? posting.workplaceType,
      });
    },
  },
};
