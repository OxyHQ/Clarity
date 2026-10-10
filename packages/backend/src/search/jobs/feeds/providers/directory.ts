/**
 * A directory of boards: a sitemap an ATS publishes of its customers' career
 * pages (JobScore lists about 500). Nothing is ingested from it; the poller
 * registers every URL it recognizes as a board Clarity reads directly as a
 * feed of its own, a batch per poll.
 *
 * Identifier: the directory sitemap's https URL (gzip accepted).
 */
import type { JobFeedProvider } from '../provider.js';
import { XML_ACCEPT, get, sitemapEntries } from '../listing.js';

export const directory: JobFeedProvider = {
  kind: 'directory',
  identifier: { meaning: 'the https URL of a sitemap listing an ATS\'s customer career pages', shape: 'url' },
  request: (identifier) => get(identifier, XML_ACCEPT),
  maxBodyBytes: 40 * 1024 * 1024,
  discoveriesPerPoll: 200,
  parse(body) {
    if (/<sitemapindex[\s>]/i.test(body)) throw new Error('this is a sitemap index; register each of its child sitemaps instead');
    return { listings: [], boardUrls: sitemapEntries(body).map((entry) => entry.url) };
  },
};
