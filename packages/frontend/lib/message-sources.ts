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

export function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function sourceFrom(value: unknown): Source | null {
  const record = asRecord(value);
  if (!record || typeof record.url !== 'string' || record.url.length === 0) return null;
  return {
    title: typeof record.title === 'string' && record.title.length > 0
      ? record.title
      : getDomain(record.url),
    url: record.url,
    snippet: typeof record.snippet === 'string' ? record.snippet : '',
    domain: getDomain(record.url),
  };
}

/**
 * Extract unique sources from tool invocations (webSearch, webScraper).
 */
export function extractSources(toolInvocations?: ToolInvocation[]): Source[] {
  if (!toolInvocations) return [];

  const seen = new Set<string>();
  const sources: Source[] = [];

  for (const inv of toolInvocations) {
    if (inv.state !== 'result' || !inv.result) continue;
    const result = asRecord(inv.result);
    if (!result) continue;

    if ((inv.toolName === 'webSearch' || (inv.toolName === 'browse' && result.action === 'search')) && Array.isArray(result.results)) {
      for (const value of result.results) {
        const source = sourceFrom(value);
        if (source && !seen.has(source.url)) {
          seen.add(source.url);
          sources.push(source);
        }
      }
    }

    if (inv.toolName === 'browse' && result.action === 'read' && typeof result.url === 'string') {
      const url = result.url;
      if (!seen.has(url)) {
        seen.add(url);
        sources.push({
          title: typeof result.title === 'string' ? result.title : getDomain(url),
          url,
          snippet: typeof result.content === 'string' ? result.content.slice(0, 200) : '',
          domain: getDomain(url),
        });
      }
    }

    // Deep research returns the sources its report cites, already numbered.
    if (Array.isArray(result.sources)) {
      for (const value of result.sources) {
        const source = sourceFrom(value);
        if (source && !seen.has(source.url)) {
          seen.add(source.url);
          sources.push(source);
        }
      }
    }

    if (inv.toolName === 'webScraper' && typeof result.url === 'string') {
      const url = result.url;
      if (!seen.has(url)) {
        seen.add(url);
        sources.push({
          title: typeof result.title === 'string' ? result.title : getDomain(url),
          url,
          snippet: typeof result.content === 'string' ? result.content.slice(0, 200) : '',
          domain: getDomain(url),
        });
      }
    }
  }

  return sources;
}

/**
 * Every source behind one assistant message: its tool results plus whatever a
 * deep-research run reported, de-duplicated by URL, in the order found.
 */
export function collectMessageSources(
  message: Pick<Message, 'toolInvocations' | 'researchProgress'>,
): Source[] {
  const sources = extractSources(message.toolInvocations);
  const seen = new Set(sources.map((source) => source.url));
  for (const value of message.researchProgress?.sources ?? []) {
    const source = sourceFrom(value);
    if (source && !seen.has(source.url)) {
      seen.add(source.url);
      sources.push(source);
    }
  }
  return sources;
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
  const withSources = (message.toolInvocations ?? [])
    .map((invocation) => extractSources([invocation]))
    .filter((sources) => sources.length > 0);
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
  const result = asRecord(invocation.result);
  if (invocation.state !== 'result' || !result || !Array.isArray(result.results)) return [];
  const domains = new Set<string>();
  for (const value of result.results) {
    const source = sourceFrom(value);
    if (source) domains.add(source.domain);
    if (domains.size >= max) break;
  }
  return [...domains];
}
