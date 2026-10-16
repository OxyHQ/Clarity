import { safeFetch } from '@oxy.so/core/server';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { ClarityExecutor } from '../db/index.js';
import { getDb } from '../db/index.js';
import { imageReferences, searchHosts } from '../db/schema/index.js';
import { recordLegacyRead } from '../files/legacy-reads.js';
import { isBlocked, isSourceFailure, oxyCanHold, oxyFiles } from '../files/oxy-files.js';
import { useImage } from '../files/references.js';
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
 * `GET /favicons/:host` (routes/favicons.ts) redirects to the icon, which is a
 * Clarity-owned Oxy file (ADR 0043), so a consumer shows a site's mark without
 * hotlinking the site or telling a third party which sites its users read.
 * Serving an icon records its use by the host (`clarity_image_references`);
 * an icon nobody is shown for 30 days is released and Oxy collects it, and the
 * next request fetches it again. An SVG icon stays in Postgres until Oxy can
 * hold one (`files/oxy-files.ts`, TODO(oxy-4c)).
 */

const USER_AGENT = 'ClarityBot/0.1 (+https://clarity.surf/bot)';
const MAX_ICON_BYTES = 100 * 1024;
const MAX_HOME_PAGE_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
/** How long a claimed host is left alone, so a crashed worker's claim expires. */
const CLAIM_MS = 15 * 60 * 1000;
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const RETRY_MS = 7 * 24 * 60 * 60 * 1000;
/** When Oxy could not take an icon (unreachable), it is fetched again this soon. */
const OXY_RETRY_MS = 60 * 60 * 1000;

const DEFAULT_PUBLIC_API_URL = 'https://api.clarity.surf';

/** The public origin Clarity serves its own assets from (`CLARITY_PUBLIC_API_URL`). */
export function publicApiBase(): string {
  return process.env.CLARITY_PUBLIC_API_URL?.trim().replace(/\/$/, '') || DEFAULT_PUBLIC_API_URL;
}

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
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.hostname.toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

/** Where Clarity serves a host's favicon. */
export function siteIconUrl(host: string): string {
  return `${publicApiBase()}/favicons/${host}`;
}

/**
 * Register the hosts of pages Clarity has seen. A new host is due for its
 * first fetch at once; a known one keeps its state, and takes a page's
 * declared icon as its hint when the page names one.
 */
export async function registerHosts(
  executor: ClarityExecutor,
  sightings: readonly HostSighting[],
): Promise<void> {
  const byHost = new Map<string, string | undefined>();
  for (const sighting of sightings) {
    const host = hostOf(sighting.url);
    if (!host) continue;
    const hint =
      sighting.iconHintUrl && hostOf(sighting.iconHintUrl) ? sighting.iconHintUrl : undefined;
    byHost.set(host, byHost.get(host) ?? hint);
  }
  if (byHost.size === 0) return;
  await executor
    .insert(searchHosts)
    .values([...byHost].map(([host, iconHintUrl]) => ({ host, iconHintUrl })))
    .onConflictDoUpdate({
      target: searchHosts.host,
      set: { iconHintUrl: sql`excluded.icon_hint_url`, updatedAt: new Date() },
      setWhere: sql`excluded.icon_hint_url is not null and excluded.icon_hint_url is distinct from ${searchHosts.iconHintUrl}`,
    });
}

/** The hosts among `hosts` whose icon Clarity can serve. */
export async function hostsWithIcons(
  executor: ClarityExecutor,
  hosts: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(hosts)];
  if (unique.length === 0) return new Set();
  const rows = await executor
    .select({ host: searchHosts.host })
    .from(searchHosts)
    .where(and(inArray(searchHosts.host, unique), eq(searchHosts.iconStatus, 'ready')));
  return new Set(rows.map((row) => row.host));
}

/** What `/favicons/:host` answers with. */
export type SiteIconAnswer =
  /** The icon is a Clarity-owned Oxy file: redirect to it. */
  | { kind: 'oxy'; oxyFileId: string }
  /** Bytes Clarity holds: an SVG (TODO(oxy-4c)), or a copy not yet migrated. */
  | ({ kind: 'local' } & SiteIcon);

/**
 * A host's icon, or `undefined` when Clarity has none to serve. Serving an Oxy
 * icon records the host's use of it; if Oxy no longer has the file, the host is
 * due for a fresh fetch and there is no icon until then.
 */
export async function readSiteIcon(
  host: string,
  now = Date.now(),
): Promise<SiteIconAnswer | undefined> {
  const [row] = await getDb()
    .select({
      contentType: searchHosts.iconContentType,
      bytes: searchHosts.iconBytes,
      oxyFileId: searchHosts.iconOxyFileId,
    })
    .from(searchHosts)
    .where(and(eq(searchHosts.host, host), eq(searchHosts.iconStatus, 'ready')))
    .limit(1);
  if (!row?.contentType) return undefined;
  if (row.oxyFileId) {
    const used = await useImage(
      { entityType: 'search_host', entityId: host, oxyFileId: row.oxyFileId },
      { now },
    );
    return used ? { kind: 'oxy', oxyFileId: row.oxyFileId } : undefined;
  }
  if (!row.bytes) return undefined;
  recordLegacyRead(oxyCanHold(row.contentType) ? 'favicons' : 'favicons_svg', now);
  return { kind: 'local', contentType: row.contentType, bytes: row.bytes };
}

/**
 * The image type these bytes actually are, or `undefined`. Sites label icons
 * `text/plain`, `application/octet-stream` or wrongly, so the header decides
 * nothing; an SVG is recognised by its root element.
 */
export function sniffImageType(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0x01 &&
    bytes[3] === 0x00
  )
    return 'image/x-icon';
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' ||
      bytes.subarray(0, 6).toString('latin1') === 'GIF89a')
  )
    return 'image/gif';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  if (
    bytes.length >= 12 &&
    bytes.subarray(4, 8).toString('latin1') === 'ftyp' &&
    ['avif', 'avis'].includes(bytes.subarray(8, 12).toString('latin1'))
  )
    return 'image/avif';
  const head = bytes.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (
    head.startsWith('<svg') ||
    ((head.startsWith('<?xml') || head.startsWith('<!--')) && head.includes('<svg'))
  )
    return 'image/svg+xml';
  return undefined;
}

/** GET a URL through `safeFetch`, keeping at most `maxBytes`; `undefined` on anything but a 200. */
export async function fetchBounded(
  url: string,
  accept: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; finalUrl: string } | undefined> {
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
  return contentType
    ? { contentType, bytes: fetched.bytes, sourceUrl: fetched.finalUrl }
    : undefined;
}

/** The icon the host's home page declares, if it declares one. */
async function declaredHomeIcon(host: string): Promise<string | undefined> {
  const page = await fetchBounded(
    `https://${host}/`,
    'text/html,application/xhtml+xml',
    MAX_HOME_PAGE_BYTES,
  ).catch(() => undefined);
  if (!page) return undefined;
  try {
    return extractDocument(page.bytes.toString('utf8'), page.finalUrl).faviconUrl;
  } catch {
    // Not a document the extractor can read: it declares nothing.
    return undefined;
  }
}

/** Fetch a host's icon: the page's hint, then the home page's, then `/favicon.ico`. */
export async function fetchSiteIcon(
  host: string,
  hintUrl: string | null,
): Promise<(SiteIcon & { sourceUrl: string }) | undefined> {
  const tried = new Set<string>();
  const attempt = async (url: string | undefined) => {
    if (!url || tried.has(url) || !hostOf(url)) return undefined;
    tried.add(url);
    return downloadIcon(url);
  };
  return (
    (await attempt(hintUrl ?? undefined)) ??
    (await attempt(await declaredHomeIcon(host))) ??
    (await attempt(`https://${host}/favicon.ico`))
  );
}

type StoredIcon =
  | { oxyFileId: string; contentType: string; sourceUrl: string }
  | { bytes: Buffer; contentType: string; sourceUrl: string };

/**
 * Where a fetched icon is kept: Oxy, as a Clarity file, unless Oxy cannot hold
 * its type (an SVG — TODO(oxy-4c)). `missing` when Oxy refused these bytes
 * (taken down, or not an image after all); `unavailable` when Oxy could not be
 * reached.
 */
async function keepIcon(
  icon: SiteIcon & { sourceUrl: string },
): Promise<StoredIcon | 'missing' | 'unavailable'> {
  if (!oxyCanHold(icon.contentType)) return icon;
  try {
    const { file } = await oxyFiles().uploadAppFile(icon.bytes, icon.contentType, {
      visibility: 'public',
    });
    return { oxyFileId: file.id, contentType: icon.contentType, sourceUrl: icon.sourceUrl };
  } catch (error) {
    return isBlocked(error) || isSourceFailure(error) ? 'missing' : 'unavailable';
  }
}

/**
 * Fetch the icons of up to `limit` due hosts. Each host is claimed first (its
 * next fetch pushed out), so the worker's replicas never fetch the same one.
 * A failed refresh keeps the icon Clarity already had.
 *
 * Only a host whose icon is in use is refreshed: one that has never been
 * fetched, one whose icon is still Clarity's own copy (which moves it into
 * Oxy), or one some request was served from in the last 30 days. An icon
 * released as unused is fetched again when it is next asked for
 * (`readSiteIcon`), not on a timer.
 */
export async function refreshDueIcons(
  limit: number,
): Promise<{ fetched: number; missing: number }> {
  const claimed = await getDb().execute<{ host: string; hint: string | null }>(sql`
    update ${searchHosts} set icon_next_fetch_at = now() + ${`${CLAIM_MS} milliseconds`}::interval
    where ${searchHosts.host} in (
      select ${searchHosts.host} from ${searchHosts}
      where ${searchHosts.iconNextFetchAt} <= now()
        and (
          ${searchHosts.iconStatus} <> 'ready'
          or ${searchHosts.iconOxyFileId} is null
          or exists (
            select 1 from ${imageReferences}
            where ${imageReferences.entityType} = 'search_host'
              and ${imageReferences.entityId} = ${searchHosts.host}
          )
        )
      order by ${searchHosts.iconNextFetchAt}
      limit ${limit}
      for update skip locked
    )
    returning ${searchHosts.host} as host, ${searchHosts.iconHintUrl} as hint`);
  let fetched = 0;
  let missing = 0;
  for (const { host, hint } of claimed) {
    const icon = await fetchSiteIcon(host, hint);
    const kept = icon ? await keepIcon(icon) : 'missing';
    const now = new Date();
    if (typeof kept === 'object') {
      fetched += 1;
      const oxyFileId = 'oxyFileId' in kept ? kept.oxyFileId : null;
      await getDb().transaction(async (tx) => {
        await tx
          .update(searchHosts)
          .set({
            iconStatus: 'ready',
            iconContentType: kept.contentType,
            iconOxyFileId: oxyFileId,
            iconBytes: 'bytes' in kept ? kept.bytes : null,
            iconSourceUrl: kept.sourceUrl,
            iconFetchedAt: now,
            iconNextFetchAt: new Date(now.getTime() + REFRESH_MS),
            updatedAt: now,
          })
          .where(eq(searchHosts.host, host));
        // The host now shows this file (or, for an SVG, no Oxy file at all):
        // the trigger owes Oxy the swap or the removal of its use.
        const use = and(
          eq(imageReferences.entityType, 'search_host'),
          eq(imageReferences.entityId, host),
        );
        if (oxyFileId) await tx.update(imageReferences).set({ oxyFileId }).where(use);
        else await tx.delete(imageReferences).where(use);
      });
    } else if (kept === 'unavailable') {
      // Oxy could not take it: nothing about the icon is learned, so the row
      // is left as it was and the host comes round again soon.
      await getDb()
        .update(searchHosts)
        .set({ iconNextFetchAt: new Date(now.getTime() + OXY_RETRY_MS), updatedAt: now })
        .where(eq(searchHosts.host, host));
    } else {
      missing += 1;
      await getDb()
        .update(searchHosts)
        .set({
          iconStatus: sql`case when ${searchHosts.iconStatus} in ('ready', 'blocked') then ${searchHosts.iconStatus} else 'missing' end`,
          iconNextFetchAt: new Date(now.getTime() + RETRY_MS),
          updatedAt: now,
        })
        .where(eq(searchHosts.host, host));
    }
  }
  return { fetched, missing };
}
