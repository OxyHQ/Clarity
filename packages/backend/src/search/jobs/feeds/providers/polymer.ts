/**
 * Polymer hiring API — one organization's public jobs, paged; each job's
 * detail adds the description, employment type and department. The posting
 * lives on the employer's own careers domain.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date, employmentTypes, get, json, listing, markdown, nextPageNumber, node, nodes, page, place, places, salaryText,
  strings, text, workplace, withQuery, DOLLAR_BY_COUNTRY,
} from '../listing.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,100}$/;

export const polymer: JobFeedProvider = {
  kind: 'polymer',
  identifier: { meaning: 'the organization slug in jobs.polymer.co/<slug>', shape: 'slug', pattern: SLUG },
  completeListing: true,
  request: (identifier, cursor) => get(withQuery(
    `https://api.polymer.co/v1/hire/organizations/${encodeURIComponent(identifier)}/jobs`, { page: cursor },
  )),
  parse(body, context) {
    const payload = node(json(body, 'polymer'));
    const meta = node(payload['meta']);
    const items = nodes(payload['items']);
    return page(items.map((job) => {
      const country = text(job['country']);
      const remote = workplace(job['remoteness_pretty']);
      return listing({
        title: text(job['title']),
        employerName: text(job['organization_name']) ?? context.label ?? context.identifier,
        canonicalUrl: text(job['job_post_url']),
        context,
        locations: places([place({ locality: job['city'], region: job['state_region'], countryCode: country, raw: job['display_location'] })]),
        workplaceType: remote,
        applicantLocationRequirements: strings(job['remote_restriction_country_list']),
        employmentTypes: employmentTypes(job['kind_pretty']),
        salary: salaryText(job['salary_pretty'], { dollar: country ? DOLLAR_BY_COUNTRY[country] : undefined }),
        occupationalCategory: text(job['job_category_name']),
        identifier: text(job['id']),
        publishedAt: date(job['published_at']),
      });
    }), meta['is_last'] === true ? undefined : nextPageNumber(context.cursor, items.length > 0));
  },
  detail: {
    request: (posting, identifier) => posting.identifier
      ? get(`https://api.polymer.co/v1/hire/organizations/${encodeURIComponent(identifier)}/jobs/${encodeURIComponent(posting.identifier)}`)
      : undefined,
    parse(body, posting, context) {
      const job = node(json(body, 'polymer'));
      if (job['archived_at']) return undefined;
      return listing({
        ...posting,
        context,
        description: markdown(job['description']),
        employmentTypes: employmentTypes(job['kind']).length > 0 ? employmentTypes(job['kind']) : posting.employmentTypes,
        department: text(job['department']) ?? posting.department,
      });
    },
  },
};
