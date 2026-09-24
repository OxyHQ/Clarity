const DEFAULT_BASE_URL = 'https://api.clarity.surf';

export interface FaviconOptions {
  /** Clarity's API origin. Defaults to `https://api.clarity.surf`. */
  baseUrl?: string;
}

/**
 * The URL Clarity serves a site's favicon at, from a public page URL or a
 * hostname.
 *
 * Clarity stores one icon per host and serves it itself (`GET /favicons/:host`),
 * so a consumer neither hotlinks the site nor tells a third party which sites
 * its users read. Only the normalized hostname reaches the URL — paths, query
 * parameters, fragments and credentials are discarded. A host Clarity has not
 * fetched yet answers 404 until its worker has it, so render the image with a
 * fallback. Search results carry `faviconUrl` already, set only once the icon
 * is stored.
 */
export function resolveFaviconUrl(input: string, options: FaviconOptions = {}): string | null {
  const hostname = normalizeHostname(input);
  if (!hostname) return null;
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  return `${base}/favicons/${hostname}`;
}

/**
 * Resolve an image resource when it is the conventional root favicon.
 *
 * This is intentionally narrower than searching an arbitrary page for icons:
 * callers pass one already-discovered image URL and receive either Clarity's
 * favicon URL for its host or `null`. Clarity receives only the hostname,
 * never the resource's path, query, credentials or surrounding data.
 */
export function resolveFaviconForImageUrl(
  resourceUrl: string,
  options: FaviconOptions = {},
): string | null {
  let url: URL;
  try {
    url = new URL(resourceUrl);
  } catch {
    return null;
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.pathname.toLowerCase() !== '/favicon.ico'
  ) {
    return null;
  }

  return resolveFaviconUrl(url.hostname, options);
}

function normalizeHostname(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) {
    return null;
  }

  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
