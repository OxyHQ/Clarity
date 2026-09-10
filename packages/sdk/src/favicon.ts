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
