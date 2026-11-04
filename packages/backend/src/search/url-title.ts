/**
 * A card for a link Clarity could not read at all: a title written from the
 * URL's own words and the site's name.
 *
 * Many publishers put the headline in the path
 * (`/grfd-crews-fight-house-fire-on-temple-street-in-grand-rapids/69-ca53…`).
 * The last path segment that reads as words becomes the title, in sentence
 * case; ids, hashes, dates and numbers are skipped, and a URL with no such
 * segment gets no title rather than a meaningless one. The document is never
 * stored: `/resolve` builds it for a `failed` URL only, its status stays
 * `failed` and its title's evidence says `url`, so no consumer mistakes it for
 * a fetched page and the next fetch replaces it.
 */
import { createHash } from 'node:crypto';

import { hostOf } from './site-icons.js';

const EXTENSION = /\.(?:s?html?|php|aspx?|jsp|cfm)$/i;
/** Segments that name a section or a format, not the page. */
const GENERIC = new Set([
  'article',
  'articles',
  'amp',
  'index',
  'news',
  'story',
  'stories',
  'post',
  'posts',
  'p',
  'blog',
  'video',
  'videos',
  'watch',
  'content',
  'view',
  'item',
  'page',
  'detail',
  'details',
]);

/** A token that is an id, a hash or a number rather than a word. */
function isOpaque(token: string): boolean {
  if (/^\d[\d.]*$/.test(token)) return true;
  if (/^[0-9a-f]{6,}$/i.test(token) && /\d/.test(token)) return true;
  const digits = token.replace(/\D/g, '').length;
  return digits > 0 && digits / token.length > 0.3;
}

/** The words a path segment spells, or `undefined` when it spells none. */
function words(segment: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return undefined;
  }
  const tokens = decoded
    .replace(EXTENSION, '')
    .split(/[-_+\s]+/)
    .filter(Boolean);
  if (tokens.length < 2 || tokens.filter(isOpaque).length > tokens.length / 2) return undefined;
  // An id is often appended to the headline (`…-community-centre-9.7407278`).
  while (tokens.length > 0 && isOpaque(tokens[tokens.length - 1])) tokens.pop();
  const kept = tokens.filter((token) => /\p{L}/u.test(token));
  if (kept.length < 2 || kept.join('').length < 8) return undefined;
  const text = kept.join(' ').toLowerCase();
  return `${text.charAt(0).toLocaleUpperCase()}${text.slice(1)}`.slice(0, 300);
}

export function titleFromUrl(url: string): string | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const segments = path
    .split('/')
    .filter((segment) => segment && !GENERIC.has(segment.toLowerCase()));
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const title = words(segments[index]);
    if (title) return title;
  }
  return undefined;
}

/**
 * The `/resolve` document for a URL Clarity could not read, or `undefined`
 * when its URL spells no title. Shaped as every other public document.
 */
export function urlDocument(url: string) {
  const title = titleFromUrl(url);
  if (!title) return undefined;
  return {
    id: `url:${createHash('sha256').update(url).digest('hex').slice(0, 32)}`,
    canonicalUrl: url,
    requestedUrl: url,
    title,
    type: 'page' as const,
    status: 'failed' as const,
    publisher: hostOf(url)?.replace(/^www\./, ''),
    authors: [],
    evidence: { title: { source: 'url', extractedAt: new Date().toISOString() } },
  };
}
