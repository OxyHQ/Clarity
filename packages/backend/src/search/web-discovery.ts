import { inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { ClarityExecutor } from '../db/index.js';
import { searchDocuments } from '../db/schema/index.js';
import { log } from '../lib/logger.js';
import { canonicalizePublicUrl } from './query-primitives.js';

/**
 * Discovering the public web for a query Clarity's own index cannot answer.
 *
 * The index holds what Clarity has crawled; a query about anything it has not
 * reached yet would come back empty. SearXNG, a keyless metasearch engine
 * running as a sidecar in this task (`packages/searxng`), asks the public
 * engines instead, and what they return is RECORDED as `discovered` documents:
 * the status the schema already has for "known, not yet fetched". So every
 * result carries a real document id, a later crawl of the same URL upgrades
 * that row in place (the crawler upserts on the canonical URL), and ranking —
 * which reads only `indexed` documents with chunks — is untouched.
 *
 * Discovery fails open: no sidecar configured, an engine outage or a slow
 * answer all return nothing, and the caller serves what the index had.
 */

const DISCOVERY_TIMEOUT_MS = 5_000;

export interface WebDiscoveryQuery {
  query: string;
  language?: string;
  domains?: readonly string[];
  limit: number;
}

export interface DiscoveredPage {
  canonicalUrl: string;
  title?: string;
  description?: string;
}

const searxngResponseSchema = z.object({
  results: z.array(z.object({
    url: z.string(),
    title: z.string().optional(),
    content: z.string().optional(),
  }).passthrough()),
}).passthrough();

/** The sidecar's origin, or `undefined` where there is none (tests, local runs). */
function searxngUrl(): string | undefined {
  return process.env.CLARITY_SEARXNG_URL?.trim().replace(/\/$/, '') || undefined;
}

/**
 * Ask SearXNG, keeping only public HTTP(S) pages — on the requested domains
 * when any were named — once each, in the order the engines ranked them.
 */
export async function discoverWeb(input: WebDiscoveryQuery): Promise<DiscoveredPage[]> {
  const origin = searxngUrl();
  if (!origin) return [];
  const domains = input.domains?.map((domain) => domain.toLowerCase()) ?? [];
  // One domain narrows at the engines; several are filtered below, because
  // the engines do not agree on how to OR `site:` operators.
  const query = domains.length === 1 ? `${input.query} site:${domains[0]}` : input.query;
  const params = new URLSearchParams({ q: query, format: 'json', safesearch: '1' });
  if (input.language) params.set('language', input.language);

  let body: unknown;
  try {
    const response = await fetch(`${origin}/search?${params}`, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`SearXNG answered ${response.status}`);
    body = await response.json();
  } catch (error) {
    log.v1.warn({ err: error }, 'Web discovery unavailable');
    return [];
  }
  const parsed = searxngResponseSchema.safeParse(body);
  if (!parsed.success) {
    log.v1.warn({ issues: parsed.error.issues.length }, 'Web discovery answered an unexpected shape');
    return [];
  }

  const pages = new Map<string, DiscoveredPage>();
  for (const result of parsed.data.results) {
    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalizePublicUrl(result.url);
    } catch {
      continue;
    }
    const host = new URL(canonicalUrl).hostname;
    if (domains.length > 0 && !domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) continue;
    if (pages.has(canonicalUrl)) continue;
    pages.set(canonicalUrl, {
      canonicalUrl,
      title: result.title?.trim() || undefined,
      description: result.content?.trim() || undefined,
    });
    if (pages.size >= input.limit) break;
  }
  return [...pages.values()];
}

/**
 * Record discovered pages and return their documents, in the order given.
 *
 * A URL the index already holds keeps its row untouched — a crawled document
 * is never overwritten by a search engine's snippet.
 */
export async function recordDiscoveredPages(
  executor: ClarityExecutor,
  pages: readonly DiscoveredPage[],
): Promise<(typeof searchDocuments.$inferSelect)[]> {
  if (pages.length === 0) return [];
  await executor.insert(searchDocuments).values(pages.map((page) => ({
    id: crypto.randomUUID(),
    requestedUrl: page.canonicalUrl,
    canonicalUrl: page.canonicalUrl,
    status: 'discovered',
    documentType: 'page',
    title: page.title,
    description: page.description,
  }))).onConflictDoNothing({ target: searchDocuments.canonicalUrl });
  const rows = await executor.select().from(searchDocuments)
    .where(inArray(searchDocuments.canonicalUrl, pages.map((page) => page.canonicalUrl)));
  const byUrl = new Map(rows.map((row) => [row.canonicalUrl, row]));
  return pages.flatMap((page) => {
    const row = byUrl.get(page.canonicalUrl);
    return row ? [row] : [];
  });
}
