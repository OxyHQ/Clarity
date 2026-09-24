import { safeFetch } from '@oxy.so/core/server';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { ClarityExecutor } from '../db/index.js';
import { getDb } from '../db/index.js';
import { searchHosts } from '../db/schema/index.js';
import { extractDocument } from './extractor.js';

/**
 * Site favicons, one per host, fetched by the worker and served by Clarity.
 *
 * A host is registered when Clarity first sees a page from it — crawled or
 * discovered through web search — and the worker fetches its icon: the one a
 * crawled page declared, else the one the site's home page declares, else
 * `/favicon.ico`. Every fetch goes through `safeFetch` (SSRF-checked on every
 * hop), is capped in size, and is kept only when its BYTES are an image — the
 * served content type is the sniffed one, never the site's header.
 *
 * `GET /favicons/:host` serves the stored icon (routes/favicons.ts), so a
 * consumer shows a site's mark without hotlinking the site or telling a third
 * party which sites its users read.
 */

const USER_AGENT = 'ClarityBot/0.1 (+https://clarity.surf/bot)';
const MAX_ICON_BYTES = 100 * 1024;
const MAX_HOME_PAGE_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
/** How long a claimed host is left alone, so a crashed worker's claim expires. */
const CLAIM_MS = 15 * 60 * 1000;
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const RETRY_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_PUBLIC_API_URL = 'https://api.clarity.surf';

export interface SiteIcon {
  contentType: string;
  bytes: Buffer;
}

export interface HostSighting {
  url: string;
  /** The icon a crawled page declared, when there is one. */
  iconHintUrl?: string;
}

/** The lower-cased host of a public HTTP(S) URL, or `undefined`. */
export function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Where Clarity serves a host's favicon. */
export function siteIconUrl(host: string): string {
  const base = process.env.CLARITY_PUBLIC_API_URL?.trim().replace(/\/$/, '') || DEFAULT_PUBLIC_API_URL;
  return `${base}/favicons/${host}`;
}

/**
 * Register the hosts of pages Clarity has seen. A new host is due for its
 * first fetch at once; a known one keeps its state, and takes a page's
 * declared icon as its hint when the page names one.
 */
export async function registerHosts(executor: ClarityExecutor, sightings: readonly HostSighting[]): Promise<void> {
  const byHost = new Map<string, string | undefined>();
  for (const sighting of sightings) {
    const host = hostOf(sighting.url);
    if (!host) continue;
    const hint = sighting.iconHintUrl && hostOf(sighting.iconHintUrl) ? sighting.iconHintUrl : undefined;
    byHost.set(host, byHost.get(host) ?? hint);
  }
  if (byHost.size === 0) return;
  await executor.insert(searchHosts)
    .values([...byHost].map(([host, iconHintUrl]) => ({ host, iconHintUrl })))
    .onConflictDoUpdate({
      target: searchHosts.host,
      set: { iconHintUrl: sql`excluded.icon_hint_url`, updatedAt: new Date() },
      setWhere: sql`excluded.icon_hint_url is not null and excluded.icon_hint_url is distinct from ${searchHosts.iconHintUrl}`,
    });
}

/** The hosts among `hosts` whose icon Clarity can serve. */
export async function hostsWithIcons(executor: ClarityExecutor, hosts: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(hosts)];
  if (unique.length === 0) return new Set();
  const rows = await executor.select({ host: searchHosts.host }).from(searchHosts)
    .where(and(inArray(searchHosts.host, unique), eq(searchHosts.iconStatus, 'ready')));
  return new Set(rows.map((row) => row.host));
}

/** A host's stored icon, or `undefined` when Clarity has none to serve. */
export async function readSiteIcon(host: string): Promise<SiteIcon | undefined> {
  const [row] = await getDb().select({ contentType: searchHosts.iconContentType, bytes: searchHosts.iconBytes })
    .from(searchHosts).where(and(eq(searchHosts.host, host), eq(searchHosts.iconStatus, 'ready'))).limit(1);
  return row?.contentType && row.bytes ? { contentType: row.contentType, bytes: row.bytes } : undefined;
}

/**
 * The image type these bytes actually are, or `undefined`. Sites label icons
 * `text/plain`, `application/octet-stream` or wrongly, so the header decides
 * nothing; an SVG is recognised by its root element.
 */
export function sniffImageType(bytes: Buffer): string | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return 'image/x-icon';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' || bytes.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const head = bytes.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || ((head.startsWith('<?xml') || head.startsWith('<!--')) && head.includes('<svg'))) return 'image/svg+xml';
  return undefined;
}

/** GET a URL through `safeFetch`, keeping at most `maxBytes`; `undefined` on anything but a 200. */
async function fetchBounded(url: string, accept: string, maxBytes: number): Promise<{ bytes: Buffer; finalUrl: string } | undefined> {
  const result = await safeFetch(url, {
    headers: { 'User-Agent': USER_AGENT, accept },
    maxRedirects: 3,
    headersTimeoutMs: FETCH_TIMEOUT_MS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2),
  });
  if (result.status !== 200) {
    result.response.destroy();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of result.response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      result.response.destroy();
      return undefined;
    }
    chunks.push(buffer);
  }
  return { bytes: Buffer.concat(chunks), finalUrl: result.finalUrl };
}

async function downloadIcon(url: string): Promise<(SiteIcon & { sourceUrl: string }) | undefined> {
  const fetched = await fetchBounded(url, 'image/*', MAX_ICON_BYTES).catch(() => undefined);
  if (!fetched || fetched.bytes.length === 0) return undefined;
  const contentType = sniffImageType(fetched.bytes);
  return contentType ? { contentType, bytes: fetched.bytes, sourceUrl: fetched.finalUrl } : undefined;
}

/** The icon the host's home page declares, if it declares one. */
async function declaredHomeIcon(host: string): Promise<string | undefined> {
  const page = await fetchBounded(`https://${host}/`, 'text/html,application/xhtml+xml', MAX_HOME_PAGE_BYTES).catch(() => undefined);
  if (!page) return undefined;
  try {
    return extractDocument(page.bytes.toString('utf8'), page.finalUrl).faviconUrl;
  } catch {
    // Not a document the extractor can read: it declares nothing.
    return undefined;
  }
}

/** Fetch a host's icon: the page's hint, then the home page's, then `/favicon.ico`. */
export async function fetchSiteIcon(host: string, hintUrl: string | null): Promise<(SiteIcon & { sourceUrl: string }) | undefined> {
  const tried = new Set<string>();
  const attempt = async (url: string | undefined) => {
    if (!url || tried.has(url) || !hostOf(url)) return undefined;
    tried.add(url);
    return downloadIcon(url);
  };
  return (await attempt(hintUrl ?? undefined))
    ?? (await attempt(await declaredHomeIcon(host)))
    ?? (await attempt(`https://${host}/favicon.ico`));
}

/**
 * Fetch the icons of up to `limit` due hosts. Each host is claimed first (its
 * next fetch pushed out), so the worker's replicas never fetch the same one.
 * A failed refresh keeps the icon Clarity already had.
 */
export async function refreshDueIcons(limit: number): Promise<{ fetched: number; missing: number }> {
  const claimed = await getDb().execute<{ host: string; hint: string | null }>(sql`
    update ${searchHosts} set icon_next_fetch_at = now() + ${`${CLAIM_MS} milliseconds`}::interval
    where ${searchHosts.host} in (
      select ${searchHosts.host} from ${searchHosts}
      where ${searchHosts.iconNextFetchAt} <= now()
      order by ${searchHosts.iconNextFetchAt}
      limit ${limit}
      for update skip locked
    )
    returning ${searchHosts.host} as host, ${searchHosts.iconHintUrl} as hint`);
  let fetched = 0;
  let missing = 0;
  for (const { host, hint } of claimed) {
    const icon = await fetchSiteIcon(host, hint);
    const now = new Date();
    if (icon) {
      fetched += 1;
      await getDb().update(searchHosts).set({
        iconStatus: 'ready', iconContentType: icon.contentType, iconBytes: icon.bytes, iconSourceUrl: icon.sourceUrl,
        iconFetchedAt: now, iconNextFetchAt: new Date(now.getTime() + REFRESH_MS), updatedAt: now,
      }).where(eq(searchHosts.host, host));
    } else {
      missing += 1;
      await getDb().update(searchHosts).set({
        iconStatus: sql`case when ${searchHosts.iconStatus} = 'ready' then 'ready' else 'missing' end`,
        iconNextFetchAt: new Date(now.getTime() + RETRY_MS), updatedAt: now,
      }).where(eq(searchHosts.host, host));
    }
  }
  return { fetched, missing };
}
