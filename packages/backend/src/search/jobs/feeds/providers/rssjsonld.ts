/**
 * Any RSS or Atom job feed whose items link to posting pages that carry their
 * own `schema.org/JobPosting` — the feed names the listings, each page states
 * them in full (Djinni, Cryptojobslist, cryptocurrencyjobs.co, Dribbble, …).
 * The item's date tells the poller when a page has not changed since it was
 * read.
 */
import type { JobFeedProvider } from '../provider.js';
import { XML_ACCEPT, date, elements, get, tag, text } from '../listing.js';
import { jsonLdPage, withoutTracking } from './pagejsonld.js';

export const rssjsonld: JobFeedProvider = {
  kind: 'rss_jsonld',
  identifier: { meaning: 'the https URL of an RSS or Atom feed whose items link to pages with JobPosting JSON-LD', shape: 'url' },
  request: (identifier) => get(identifier, XML_ACCEPT),
  parse(body) {
    const items = [...elements(body, 'item'), ...elements(body, 'entry')];
    return {
      listings: [],
      references: items.flatMap((item) => {
        const link = text(tag(item, 'link')) ?? /<link[^>]*href="([^"]+)"/i.exec(item)?.[1] ?? text(tag(item, 'media:canonical'));
        if (!link) return [];
        const modified = date(text(tag(item, 'pubDate')) ?? text(tag(item, 'updated')) ?? text(tag(item, 'published')));
        return [{ url: withoutTracking(link), ...(modified ? { lastModified: modified } : {}) }];
      }),
    };
  },
  listingPage: jsonLdPage,
};
