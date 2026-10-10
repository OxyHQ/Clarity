/**
 * Gem job board API — one company's public posts in one response. Gem carries
 * no pay field.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date, employmentTypes, get, json, listing, locationText, markdown, node, nodes, page, places, text, workplace,
} from '../listing.js';

export const gem: JobFeedProvider = {
  kind: 'gem',
  identifier: { meaning: 'the board path in jobs.gem.com/<board>', shape: 'slug', pattern: /^[a-z0-9][a-z0-9-]{0,100}$/ },
  request: (identifier) => get(`https://api.gem.com/job_board/v0/${encodeURIComponent(identifier)}/job_posts/`),
  parse(body, context) {
    return page(nodes(json(body, 'gem')).map((job) => listing({
      title: text(job['title']),
      employerName: context.label ?? context.identifier,
      canonicalUrl: text(job['absolute_url']),
      context,
      description: markdown(job['content'] ?? job['content_plain']),
      locations: places([
        ...locationText(text(node(job['location'])['name'])),
        ...nodes(job['offices']).flatMap((office) => locationText(text(node(office['location'])['name']))),
      ]),
      workplaceType: workplace(job['location_type']),
      employmentTypes: employmentTypes(job['employment_type']),
      department: text(nodes(job['departments'])[0]?.['name']),
      identifier: text(job['requisition_id']) ?? text(job['id']),
      publishedAt: date(job['first_published_at'] ?? job['created_at']),
    })));
  },
};
