import config from './config';

/**
 * The site's favicon as Clarity serves it — one stored icon per host, so the
 * page neither hotlinks the site nor names it to a third party.
 */
export function faviconUrl(href: string): string | undefined {
  try {
    return `${config.apiUrl}/favicons/${new URL(href).hostname.toLowerCase()}`;
  } catch {
    return undefined;
  }
}
