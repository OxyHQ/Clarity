/**
 * Any job site that publishes a sitemap of its postings and a
 * `schema.org/JobPosting` on each posting page — the shape most public-sector
 * portals and many careers sites have, with no list API at all.
 *
 * The identifier is the sitemap's https URL, optionally followed by
 * `#/path/prefix/` to keep only the posting pages of a sitemap that lists
 * other pages too. The sitemap is walked newest-modified first, 200 entries
 * per page; each posting page is read once and then only again when the
 * sitemap says it changed or the cache ages out. Each page's JSON-LD goes
 * through the shared extractor; a page without a `JobPosting` is not a listing.
 * A sitemap index is not walked: its child sitemaps are registered instead.
 */
import type { JobFeedPageReference, JobFeedProvider } from '../provider.js';
import { registrableApex } from '@oxy.so/core/server';

import { XML_ACCEPT, get, sitemapEntries } from '../listing.js';
import { jsonLdPage } from './pagejsonld.js';

const PAGE_SIZE = 200;

function sitemapUrl(identifier: string): { url: string; prefix?: string } {
  const [url, fragment] = identifier.split('#');
  return { url, ...(fragment ? { prefix: fragment } : {}) };
}

export const sitemap: JobFeedProvider = {
  kind: 'sitemap',
  identifier: { meaning: 'the https URL of a sitemap of posting pages, optionally #/path/prefix/', shape: 'url' },
  completeListing: true,
  request: (identifier) => get(sitemapUrl(identifier).url, XML_ACCEPT),
  // A large portal's sitemap of postings runs to several megabytes.
  maxBodyBytes: 40 * 1024 * 1024,
  parse(body, context) {
    if (/<sitemapindex[\s>]/i.test(body)) {
      throw new Error('this is a sitemap index; register each of its child sitemaps instead');
    }
    const { url, prefix } = sitemapUrl(context.identifier);
    // Postings live on the sitemap's own site, but a sitemap is often served
    // from a CDN host (statics.free-work.com → www.free-work.com), so the test
    // is the same registrable domain, not the exact host.
    const apex = registrableApex(new URL(url).hostname);
    const entries = sitemapEntries(body)
      .filter((entry) => { try { const target = new URL(entry.url); return (apex ? registrableApex(target.hostname) === apex : target.hostname === new URL(url).hostname) && (!prefix || target.pathname.startsWith(prefix)); } catch { return false; } })
      .sort((left, right) => (right.lastModified?.getTime() ?? 0) - (left.lastModified?.getTime() ?? 0));
    const offset = Number(context.cursor ?? 0) || 0;
    const references: JobFeedPageReference[] = entries.slice(offset, offset + PAGE_SIZE);
    return {
      listings: [],
      references,
      ...(offset + PAGE_SIZE < entries.length ? { nextCursor: String(offset + PAGE_SIZE) } : {}),
    };
  },
  listingPage: jsonLdPage,
};
