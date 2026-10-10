/**
 * Crelate (US staffing agencies) — each agency portal's RSS. The employer is
 * the agency that publishes the job, as the portal presents it.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  XML_ACCEPT,
  elements,
  get,
  listing,
  locationText,
  markdown,
  page,
  places,
  tag,
  text,
} from '../listing.js';

export const crelate: JobFeedProvider = {
  kind: 'crelate',
  identifier: {
    meaning: 'the portal in jobs.crelate.com/portal/<portal>',
    shape: 'slug',
    pattern: /^[a-z0-9][a-z0-9_-]{0,60}$/i,
  },
  completeListing: true,
  request: (identifier) =>
    get(`https://jobs.crelate.com/portal/${encodeURIComponent(identifier)}/rss`, XML_ACCEPT),
  parse(body, context) {
    const channel = text(tag(body, 'title'))?.replace(/\s+Jobs Feed$/i, '');
    return page(
      elements(body, 'item').map((item) =>
        listing({
          title: text(tag(item, 'title')),
          employerName: context.label ?? channel ?? context.identifier,
          canonicalUrl: text(tag(item, 'link')) ?? text(tag(item, 'guid')),
          context,
          description: markdown(tag(item, 'description')),
          locations: places(locationText(text(tag(item, 'crelate:location')))),
          identifier: text(tag(item, 'crelate:jobNumber')),
        }),
      ),
    );
  },
};
