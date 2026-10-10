/**
 * Homerun — each company's public Atom feed at feed.homerun.co, every open
 * job with its full description, department and type.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  XML_ACCEPT,
  elements,
  employmentTypes,
  get,
  listing,
  markdown,
  page,
  places,
  salaryText,
  tag,
  text,
  place,
} from '../listing.js';

export const homerun: JobFeedProvider = {
  kind: 'homerun',
  identifier: {
    meaning: 'the company subdomain in <company>.homerun.co',
    shape: 'slug',
    pattern: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  },
  completeListing: true,
  request: (identifier) => get(`https://feed.homerun.co/${identifier}`, XML_ACCEPT),
  parse(body, context) {
    const employerFallback = text(tag(body, 'title'));
    return page(
      elements(body, 'entry').map((entry) => {
        const department = tag(entry, 'department');
        const location = tag(entry, 'location');
        const type = tag(entry, 'type');
        return listing({
          title: text(tag(entry, 'title')),
          employerName:
            text(tag(tag(entry, 'author') ?? '', 'name')) ?? employerFallback ?? context.identifier,
          canonicalUrl: /<link[^>]*href="([^"]+)"/i.exec(entry)?.[1],
          context,
          description: markdown(tag(entry, 'description') ?? tag(entry, 'content')),
          locations: places([place({ raw: location ? tag(location, 'name') : undefined })]),
          employmentTypes: employmentTypes(type ? tag(type, 'name') : undefined),
          salary: salaryText(tag(entry, 'salary_indication')),
          department: department ? text(tag(department, 'name')) : undefined,
          // `updated` is when the posting was last edited, not when it was published.
          identifier: text(tag(entry, 'id')),
        });
      }),
    );
  },
};
