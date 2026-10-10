/**
 * PageUp career sites — the board's RSS, which carries each posting's full
 * `job:` fields (description, location, work type, closing date, reference).
 * PageUp publishes no employer name in the feed, so the feed's label is the
 * employer. The identifier is the RSS URL, since the host varies per customer
 * (`jobs.unicef.org`, `explore.jobs.ufl.edu`, `careers.pageuppeople.com/<id>`).
 */
import type { JobFeedProvider } from '../provider.js';
import {
  XML_ACCEPT, date, elements, employmentTypesIn, get, listing, markdown, page, place, places, tag, text,
} from '../listing.js';

export const pageup: JobFeedProvider = {
  kind: 'pageup',
  identifier: { meaning: 'the https URL of a PageUp RSS feed (…/cw/<locale>/rss)', shape: 'url' },
  completeListing: true,
  request: (identifier) => get(identifier, XML_ACCEPT),
  maxBodyBytes: 40 * 1024 * 1024,
  parse(body, context) {
    return page(elements(body, 'item').map((item) => {
      // "Headquarters|United States", "New South Wales|Sydney": pipe-separated, coarsest first.
      const parts = (text(tag(item, 'job:location')) ?? '').split('|').map((value) => value.trim()).filter(Boolean);
      return listing({
        title: text(tag(item, 'title'))?.replace(/\s*#\d+$/, ''),
        employerName: context.label,
        canonicalUrl: text(tag(item, 'link')) ?? text(tag(item, 'guid')),
        context,
        description: markdown(tag(item, 'job:description') ?? tag(item, 'description')),
        locations: places([parts.length ? place({ raw: parts.join(', '), locality: parts[parts.length - 1] }) : undefined]),
        employmentTypes: employmentTypesIn(tag(item, 'job:workType')),
        occupationalCategory: text(tag(item, 'job:category'))?.split(',')[0]?.split('|').pop(),
        identifier: text(tag(item, 'job:refNo')),
        publishedAt: date(text(tag(item, 'pubDate')) ?? text(tag(item, 'a10:updated'))),
        validThrough: date(text(tag(item, 'job:closingDate'))),
      });
    }));
  },
};
