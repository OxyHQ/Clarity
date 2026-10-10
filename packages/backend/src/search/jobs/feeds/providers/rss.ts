/**
 * Generic RSS/Atom. A feed states far less than a board API, so most fields
 * stay absent — which is correct. The employer comes from the channel title
 * only when the item does not name one, and never from the item's prose.
 */
import type { JobFeedProvider } from '../provider.js';
import { XML_ACCEPT, date, elements, get, listing, markdown, page, tag, text, xmlText } from '../listing.js';

export const rss: JobFeedProvider = {
  kind: 'rss',
  identifier: { meaning: 'the absolute https URL of the RSS or Atom feed', shape: 'url' },
  request: (identifier) => get(identifier, XML_ACCEPT),
  parse(body, context) {
    const channelTitle = /<channel>[\s\S]*?<title>([\s\S]*?)<\/title>/i.exec(body)?.[1]
      ?? /<feed[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
    const employerFallback = channelTitle ? text(xmlText(channelTitle)) : undefined;
    const items = [...elements(body, 'item'), ...elements(body, 'entry')];
    return page(items.map((item) => listing({
      title: text(tag(item, 'title')),
      employerName: text(tag(item, 'dc:creator')) ?? text(tag(item, 'author')) ?? employerFallback,
      canonicalUrl: text(tag(item, 'link')) ?? /<link[^>]*href="([^"]+)"/i.exec(item)?.[1],
      context,
      description: markdown(tag(item, 'content:encoded') ?? tag(item, 'description') ?? tag(item, 'summary')),
      identifier: text(tag(item, 'guid')) ?? text(tag(item, 'id')),
      publishedAt: date(text(tag(item, 'pubDate')) ?? text(tag(item, 'published')) ?? text(tag(item, 'updated'))),
    })));
  },
};
