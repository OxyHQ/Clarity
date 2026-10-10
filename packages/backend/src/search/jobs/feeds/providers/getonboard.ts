/**
 * Get on Board — Latin American tech jobs through its public API ("Open to
 * anyone… No authentication required"), one category per feed. Each job
 * states its description, functions, benefits and desirable skills as separate
 * sections, the remote modality and countries. Its salary figures carry no
 * currency or period, so pay is not read.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  epochSeconds,
  get,
  json,
  listing,
  markdown,
  nextPageNumber,
  node,
  nodes,
  num,
  page,
  place,
  places,
  strings,
  text,
  workplace,
} from '../listing.js';

const PAGE_SIZE = 100;

export const getonboard: JobFeedProvider = {
  kind: 'getonboard',
  identifier: {
    meaning: 'a category slug from getonbrd.com/api/v0/categories, e.g. programming',
    shape: 'slug',
    pattern: /^[a-z0-9][a-z0-9-]{0,60}$/,
  },
  completeListing: true,
  request: (identifier, cursor) =>
    get(
      `https://www.getonbrd.com/api/v0/categories/${encodeURIComponent(identifier)}/jobs?per_page=${PAGE_SIZE}&page=${Number(cursor ?? 1) || 1}&expand=${encodeURIComponent('["company"]')}`,
    ),
  terms: 'Public API: open to anyone, no authentication required.',
  parse(body, context) {
    const payload = node(json(body, 'getonboard'));
    const jobs = nodes(payload.data);
    const current = Number(context.cursor ?? 1) || 1;
    return page(
      jobs.map((job) => {
        const attributes = node(job.attributes);
        const company = node(node(node(attributes.company).data).attributes);
        const modality = text(attributes.remote_modality);
        return listing({
          title: text(attributes.title),
          employerName: text(company.name),
          canonicalUrl: text(node(job.links).public_url),
          context,
          description: markdown(attributes.description, attributes.projects),
          responsibilities: markdown(attributes.functions),
          qualifications: markdown(attributes.desirable),
          benefits: markdown(attributes.benefits),
          employerUrl: text(company.web),
          employerLogoUrl: text(company.logo),
          // fully_remote / remote_local are remote; hybrid and no_remote say so.
          workplaceType:
            modality === 'no_remote'
              ? 'onsite'
              : workplace(
                  modality?.split('_').find((part) => part !== 'fully' && part !== 'local'),
                ),
          // A remote role's countries are where applicants may be; anyone else's are where the job is.
          ...(modality === 'fully_remote' || modality === 'remote_local'
            ? { applicantLocationRequirements: strings(attributes.countries) }
            : {
                locations: places(
                  strings(attributes.countries).map((country) => place({ country })),
                ),
              }),
          occupationalCategory: text(attributes.category_name),
          identifier: text(job.id),
          publishedAt: epochSeconds(attributes.published_at),
        });
      }),
      nextPageNumber(context.cursor, current < (num(node(payload.meta).total_pages) ?? 0)),
    );
  },
};
