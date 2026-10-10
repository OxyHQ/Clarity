/**
 * Trakstar Hire (formerly Recruiterbox) — each company's job RSS, with full
 * HTML descriptions and the board's own `job:` location, type and team fields.
 */
import type { JobFeedProvider } from '../provider.js';
import { XML_ACCEPT, date, elements, employmentTypes, get, listing, markdown, page, place, places, tag, text } from '../listing.js';

export const trakstar: JobFeedProvider = {
  kind: 'trakstar',
  identifier: { meaning: 'the subdomain in <sub>.hire.trakstar.com', shape: 'slug', pattern: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/ },
  completeListing: true,
  request: (identifier) => get(`https://${identifier}.hire.trakstar.com/jobfeeds/${encodeURIComponent(identifier)}`, XML_ACCEPT),
  parse(body, context) {
    const channel = text(tag(body, 'title'))?.replace(/^Jobs at\s+/i, '');
    return page(elements(body, 'item').map((item) => {
      const link = text(tag(item, 'link'));
      return listing({
        title: text(tag(item, 'title')),
        employerName: context.label ?? channel ?? context.identifier,
        canonicalUrl: link?.replace(/^http:/, 'https:'),
        context,
        description: markdown(tag(item, 'description')),
        locations: places([place({ locality: tag(item, 'job:locationCity'), region: tag(item, 'job:locationState'), country: tag(item, 'job:locationCountry') })]),
        employmentTypes: employmentTypes(tag(item, 'job:positionType')),
        department: text(tag(item, 'job:team')),
        identifier: link ? /\/jobs\/([a-z0-9]+)/i.exec(link)?.[1] : undefined,
        publishedAt: date(text(tag(item, 'pubDate'))),
        validThrough: date(text(tag(item, 'job:closeDte'))),
      });
    }));
  },
};
