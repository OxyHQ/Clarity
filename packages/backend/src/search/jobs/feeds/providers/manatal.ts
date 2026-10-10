/**
 * Manatal career page API — one company's public jobs, paged by page number.
 * The public posting lives on careers-page.com under the job's hash.
 */
import type { JobFeedProvider } from '../provider.js';
import {
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
  text,
  withQuery,
} from '../listing.js';

export const manatal: JobFeedProvider = {
  kind: 'manatal',
  identifier: {
    meaning: 'the career page slug in careers-page.com/<slug>',
    shape: 'slug',
    pattern: /^[a-z0-9][a-z0-9-]{0,100}$/,
  },
  completeListing: true,
  request: (identifier, cursor) =>
    get(
      withQuery(
        `https://api.manatal.com/open/v3/career-page/${encodeURIComponent(identifier)}/jobs/`,
        { page_size: 100, page: cursor },
      ),
    ),
  parse(body, context) {
    const payload = node(json(body, 'manatal'));
    const results = nodes(payload.results);
    return page(
      results.map((job) => {
        const hash = text(job.hash);
        return listing({
          title: text(job.position_name),
          employerName: context.label ?? context.identifier,
          canonicalUrl: hash
            ? `https://www.careers-page.com/${encodeURIComponent(context.identifier)}/job/${encodeURIComponent(hash)}`
            : undefined,
          context,
          description: markdown(job.description),
          locations: places([
            place({
              locality: job.city,
              region: job.state,
              country: job.country,
              postalCode: job.zipcode,
              raw: job.location_display,
            }),
          ]),
          ...(job.is_remote === true ? { workplaceType: 'remote' as const } : {}),
          employmentTypes: employmentTypes(job.contract_details),
          // Manatal's `organization_name` is the team the role sits in, not the employer.
          department: text(job.organization_name),
          identifier: text(job.id),
        });
      }),
      nextPageNumber(context.cursor, typeof payload.next === 'string'),
    );
  },
};
