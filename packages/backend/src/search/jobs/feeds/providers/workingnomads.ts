/**
 * Working Nomads public API — its current remote listings in one response.
 */
import type { JobFeedProvider } from '../provider.js';
import { date, get, json, listing, markdown, nodes, page, strings, text } from '../listing.js';

export const workingnomads: JobFeedProvider = {
  kind: 'workingnomads',
  identifier: { meaning: 'unused; leave it as the kind name', shape: 'none' },
  request: () => get('https://www.workingnomads.com/api/exposed_jobs/'),
  parse(body, context) {
    return page(nodes(json(body, 'workingnomads')).map((job) => {
      const url = text(job['url']);
      const where = text(job['location']);
      return listing({
        title: text(job['title']),
        employerName: text(job['company_name']),
        canonicalUrl: url,
        context,
        description: markdown(job['description']),
        workplaceType: 'remote',
        // "Time zone: CET (+/- 3 hours)", "USA": where applicants must be, as stated.
        applicantLocationRequirements: where && !/^(?:global|anywhere|worldwide)$/i.test(where) ? [where] : [],
        skills: strings(job['tags'], 20),
        occupationalCategory: text(job['category_name']),
        identifier: url ? /\/job\/go\/(\d+)/.exec(url)?.[1] : undefined,
        publishedAt: date(job['pub_date']),
      });
    }));
  },
};
