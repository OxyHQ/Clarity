/** Links as Clarity draws them: a page's title, URL, an excerpt and its site. Pure. */

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
