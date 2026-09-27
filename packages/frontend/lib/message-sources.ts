import type { Message, ToolInvocation } from '@clarity/shared-types';

/**
 * The links behind an assistant message — pure, so the chat, the step list and
 * the tests all read the same answer. Nothing here loads React Native.
 */

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sourceFrom(value: unknown, snippetField = 'snippet'): Source | null {
  const record = asRecord(value);
  if (!record || typeof record.url !== 'string' || record.url.length === 0) return null;
  const domain = hostnameOf(record.url) ?? record.url;
  const snippet = record[snippetField];
  return {
    title: typeof record.title === 'string' && record.title.length > 0 ? record.title : domain,
    url: record.url,
    snippet: typeof snippet === 'string' ? snippet.slice(0, 200) : '',
    domain,
  };
}

/**
 * The links one finished tool call returned: a search's results, the page a
 * read or scrape fetched, or the sources a research run cites.
 */
export function linksOf(invocation: ToolInvocation): Source[] {
  const result = asRecord(invocation.result);
  if (invocation.state !== 'result' || !result) return [];
  const { toolName } = invocation;
  const list = (values: unknown) => (Array.isArray(values) ? values.flatMap((value) => sourceFrom(value) ?? []) : []);
  if (toolName === 'webSearch' || (toolName === 'browse' && result.action === 'search')) return list(result.results);
  if (toolName === 'webScraper' || (toolName === 'browse' && result.action === 'read')) {
    const page = sourceFrom(result, 'content');
    return page ? [page] : [];
  }
  return list(result.sources);
}

function uniqueByUrl(sources: Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((source) => !seen.has(source.url) && Boolean(seen.add(source.url)));
}

/**
 * Every source behind one assistant message: its tool results plus whatever a
 * deep-research run reported, de-duplicated by URL, in the order found.
 */
export function collectMessageSources(
  message: Pick<Message, 'toolInvocations' | 'researchProgress'>,
): Source[] {
  return uniqueByUrl([
    ...(message.toolInvocations ?? []).flatMap(linksOf),
    ...(message.researchProgress?.sources ?? []).flatMap((value) => sourceFrom(value) ?? []),
  ]);
}

/**
 * The URL each citation number `[n]` points at, only where the numbering is
 * certain. A research run numbers its own sources. Otherwise the model numbers
 * the results of the search it read, so `[n]` is that search's n-th result —
 * which is unambiguous only when a single tool call returned sources. With
 * several, a marker could mean any of them, and a wrong link is worse than none.
 */
export function citationUrls(
  message: Pick<Message, 'toolInvocations' | 'researchProgress'>,
): Map<number, string> {
  const urls = new Map<number, string>();
  for (const source of message.researchProgress?.sources ?? []) {
    if (typeof source.id === 'number' && typeof source.url === 'string') urls.set(source.id, source.url);
  }
  if (urls.size > 0) return urls;
  const withSources = (message.toolInvocations ?? []).map(linksOf).filter((links) => links.length > 0);
  if (withSources.length === 1) withSources[0].forEach((source, index) => urls.set(index + 1, source.url));
  return urls;
}

/**
 * Turns bare citation markers (`[1]`, `[2][3]`) into Markdown links to their
 * sources. A marker with no known source, or one that is already a link, is
 * left as written.
 */
export function linkCitations(text: string, urls: ReadonlyMap<number, string>): string {
  if (urls.size === 0) return text;
  return text.replace(/(?<!\[)\[(\d{1,3})\](?![(:])/g, (marker, digits: string) => {
    const url = urls.get(Number(digits));
    return url ? `[[${digits}]](${url})` : marker;
  });
}

/** The distinct sites a finished search step returned, for its step row. */
export function resultDomains(invocation: ToolInvocation, max = 3): string[] {
  return [...new Set(linksOf(invocation).map((source) => source.domain))].slice(0, max);
}
