/** Links as Clarity draws them: a page's title, URL, an excerpt and its site. */
import config from './config';

export interface Source {
  title: string;
  url: string;
  snippet: string;
  domain: string;
}

/** A URL's hostname without a leading `www.`, or `undefined` if it is not a URL. */
export function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

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
