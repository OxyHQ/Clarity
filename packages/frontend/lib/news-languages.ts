/**
 * The languages Discover asks for: the reader's own, then English, which most
 * of the indexed news is in. Primary subtags only — `es-MX` reads `es` news.
 */
export function newsLanguagesFor(locale: string | undefined): string[] {
  const own = (locale ?? '').toLowerCase().split(/[-_]/)[0];
  return [...new Set([own, 'en'].filter((language) => /^[a-z]{2,3}$/.test(language)))];
}
