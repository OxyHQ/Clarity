const DEFAULT_FAVICON_SIZE = 64;

/**
 * Build Clarity's canonical favicon URL from a public page URL or hostname.
 *
 * Only the normalized hostname is sent to the favicon service. Paths, query
 * parameters, fragments, credentials and all surrounding document data are
 * deliberately discarded.
 */
export function resolveFaviconUrl(input: string, size = DEFAULT_FAVICON_SIZE): string | null {
  const hostname = normalizeHostname(input);
  if (!hostname) return null;

  const normalizedSize = Number.isSafeInteger(size) && size > 0 && size <= 256
    ? size
    : DEFAULT_FAVICON_SIZE;
  return `https://www.google.com/s2/favicons?sz=${normalizedSize}&domain_url=${encodeURIComponent(hostname)}`;
}

/**
 * Resolve an image resource when it is the conventional root favicon.
 *
 * This is intentionally narrower than searching an arbitrary page for icons:
 * callers pass one already-discovered image URL and receive either Clarity's
 * privacy-minimized favicon URL or `null`. The provider receives only the
 * resource hostname, never its path, query, credentials or surrounding data.
 */
export function resolveFaviconForImageUrl(
  resourceUrl: string,
  size = DEFAULT_FAVICON_SIZE,
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

  return resolveFaviconUrl(url.hostname, size);
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
