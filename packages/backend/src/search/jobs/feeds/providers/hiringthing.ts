/**
 * HiringThing (US) — each company's RSS, every open job with its full HTML
 * description in `media:description`.
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

export const hiringthing: JobFeedProvider = {
  kind: 'hiringthing',
  identifier: {
    meaning: 'the subdomain in <sub>.hiringthing.com',
    shape: 'slug',
    pattern: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  },
  completeListing: true,
  request: (identifier) => get(`https://${identifier}.hiringthing.com/api/rss.xml`, XML_ACCEPT),
  parse(body, context) {
    const channel = text(tag(body, 'title'))?.replace(/\s+Jobs$/i, '');
    return page(
      elements(body, 'item').map((item) => {
        const link = text(tag(item, 'link'));
        return listing({
          title: text(tag(item, 'title')),
          employerName: context.label ?? channel ?? context.identifier,
          canonicalUrl: link,
          context,
          description: markdown(tag(item, 'media:description') ?? tag(item, 'description')),
          locations: places(locationText(text(tag(item, 'location')))),
          occupationalCategory: text(tag(item, 'category')),
          identifier: link ? /\/job\/(\d+)\//.exec(link)?.[1] : undefined,
        });
      }),
    );
  },
};
