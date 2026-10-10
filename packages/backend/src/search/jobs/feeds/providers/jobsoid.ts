/**
 * Jobsoid — each company's public jobs API, every open job with its HTML
 * description, location, department and function.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date,
  employmentTypesIn,
  get,
  json,
  listing,
  markdown,
  node,
  nodes,
  page,
  place,
  places,
  text,
} from '../listing.js';

export const jobsoid: JobFeedProvider = {
  kind: 'jobsoid',
  identifier: {
    meaning: 'the subdomain in <sub>.jobsoid.com',
    shape: 'slug',
    pattern: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  },
  completeListing: true,
  request: (identifier) => get(`https://${identifier}.jobsoid.com/api/v1/jobs`),
  parse(body, context) {
    return page(
      nodes(json(body, 'jobsoid')).map((job) => {
        const where = node(job['location']);
        return listing({
          title: text(job['title']),
          employerName: text(job['company']) ?? context.label ?? context.identifier,
          canonicalUrl: text(job['hostedUrl']),
          applyUrl: text(job['applyUrl']),
          context,
          description: markdown(job['description']),
          locations: places([
            place({ locality: where['city'], country: where['country'], raw: where['title'] }),
          ]),
          employmentTypes: employmentTypesIn(job['type']),
          industry: text(job['industry']),
          occupationalCategory: text(node(job['function'])['title']),
          department: text(node(job['department'])['title']),
          identifier: text(job['id']),
          publishedAt: date(job['postedDate']),
          validThrough: date(job['closingDate']),
        });
      }),
    );
  },
};
