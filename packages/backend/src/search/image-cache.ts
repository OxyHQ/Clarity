import { createHash } from 'node:crypto';
import { and, eq, lt, or, sql } from 'drizzle-orm';

import { getDb } from '../db/index.js';
import { imageCache } from '../db/schema/index.js';
import {
  RENDERABLE_IMAGE_ACCEPT,
  STORED_IMAGE_RENDITION,
  renderStoredImage,
  type RenderedImage,
} from './image-render.js';
import { fetchBounded, hostOf, publicApiBase } from './site-icons.js';

/**
 * Remote images served from Clarity: a document's preview image and a job's
 * employer logo.
 *
 * The API never hands a consumer a site's own image URL. It hands out
 * `GET /images/<kind>/<id>/<version>` (routes/images.ts), and Clarity fetches
 * the image itself — through `safeFetch`, SSRF-checked on every hop, capped in
 * size — and serves its own rendition of it. A reader's browser therefore never
 * asks the site for anything, and the site never learns who read what.
 *
 * What is kept is NEVER the site's original: only the compressed WebP
 * rendition `image-render.ts` makes (the `w1280` rung of Oxy's image ladder),
 * and smaller rungs are rendered from it when asked for. Bytes that do not
 * decode as an image yield no rendition, so they are never kept either.
 *
 * The copy is a cache with its own expiry, not an archive:
 *  - filled lazily, the first time anyone asks for the image;
 *  - refetched once it is older than {@link IMAGE_REFRESH_MS};
 *  - deleted by the worker's {@link sweepImageCache} when nobody has asked for
 *    it in {@link IMAGE_IDLE_TTL_MS}, so unread images do not accumulate;
 *  - a failed fetch is remembered for {@link IMAGE_MISS_TTL_MS}, so a broken
 *    image costs one fetch per window instead of one per request.
 *
 * The route resolves the source URL from Clarity's own rows by id, never from
 * the request, so it cannot be used as an open proxy.
 */

export type ImageKind = 'documents' | 'jobs';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
export const IMAGE_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const IMAGE_MISS_TTL_MS = 6 * 60 * 60 * 1000;
/** `last_accessed_at` is written at most this often per image, not on every hit. */
const ACCESS_TOUCH_MS = 24 * 60 * 60 * 1000;
/** Rows deleted per sweep statement, so one sweep never holds a long lock. */
const SWEEP_BATCH = 500;

/** What the cache serves: always a rendition, never a site's bytes. */
export type CachedImage = RenderedImage;

/** The cache key of an image: the SHA-256 of its source URL. */
export function imageKey(sourceUrl: string): string {
  return createHash('sha256').update(sourceUrl).digest('hex');
}

/**
 * The version segment of an image URL. It changes when the source URL does, so
 * a consumer (and every CDN between it and Clarity) treats a re-crawled image as
 * a new resource instead of serving the old one.
 */
export function imageVersion(sourceUrl: string): string {
  return imageKey(sourceUrl).slice(0, 16);
}

/**
 * Where Clarity serves this image, or `undefined` when there is no image a
 * consumer could show (no URL, or not a public HTTP(S) one).
 */
export function publicImageUrl(
  kind: ImageKind,
  id: string,
  sourceUrl: string | null | undefined,
): string | undefined {
  if (!sourceUrl || !hostOf(sourceUrl)) return undefined;
  return `${publicApiBase()}/images/${kind}/${encodeURIComponent(id)}/${imageVersion(sourceUrl)}`;
}

async function download(sourceUrl: string): Promise<CachedImage | undefined> {
  const fetched = await fetchBounded(sourceUrl, RENDERABLE_IMAGE_ACCEPT, MAX_IMAGE_BYTES).catch(
    () => undefined,
  );
  if (!fetched || fetched.bytes.length === 0) return undefined;
  return renderStoredImage(fetched.bytes);
}

/** Fetches in progress in this process, so concurrent misses share one download. */
const inFlight = new Map<string, Promise<CachedImage | undefined>>();

async function fetchAndStore(
  key: string,
  sourceUrl: string,
  at: number,
): Promise<CachedImage | undefined> {
  const image = await download(sourceUrl);
  const now = new Date(at);
  const values = image
    ? {
        status: 'ready',
        contentType: image.contentType,
        bytes: image.bytes,
        byteSize: image.bytes.length,
        rendition: STORED_IMAGE_RENDITION,
      }
    : { status: 'missing', contentType: null, bytes: null, byteSize: 0 };
  await getDb()
    .insert(imageCache)
    .values({ key, sourceUrl, ...values, fetchedAt: now, lastAccessedAt: now })
    .onConflictDoUpdate({
      target: imageCache.key,
      // A failed REFRESH keeps the copy Clarity already had; only a first
      // fetch, or a successful one, writes the row.
      set: image
        ? { sourceUrl, ...values, fetchedAt: now, lastAccessedAt: now }
        : {
            // A failed REFRESH keeps the old bytes but must not reset their
            // age: dating the row as if the refresh had succeeded would serve
            // the old copy as fresh for another full refresh period. It is
            // dated so the next attempt comes one miss-window from now, the
            // same wait a first failure gets.
            fetchedAt: sql`case when ${imageCache.status} = 'ready'
              then ${new Date(now.getTime() - IMAGE_REFRESH_MS + IMAGE_MISS_TTL_MS).toISOString()}::timestamptz
              else ${now.toISOString()}::timestamptz end`,
            lastAccessedAt: now,
            status: sql`case when ${imageCache.status} = 'ready' then 'ready' else 'missing' end`,
          },
    });
  if (image) return image;
  // The refresh failed: serve the previous copy if there is one — re-rendered
  // first if an older pipeline kept it.
  const [kept] = await getDb()
    .select({ bytes: imageCache.bytes, rendition: imageCache.rendition })
    .from(imageCache)
    .where(and(eq(imageCache.key, key), eq(imageCache.status, 'ready')))
    .limit(1);
  if (!kept?.bytes) return undefined;
  if (kept.rendition < STORED_IMAGE_RENDITION) {
    const rendered = await rerender(key, kept.bytes, at, true);
    if (rendered) return rendered;
    // The old copy is gone and the site just failed: remember the miss, so a
    // broken site still costs one fetch per window.
    await getDb()
      .insert(imageCache)
      .values({
        key,
        sourceUrl,
        status: 'missing',
        contentType: null,
        bytes: null,
        byteSize: 0,
        fetchedAt: now,
        lastAccessedAt: now,
      })
      .onConflictDoNothing();
    return undefined;
  }
  return { contentType: 'image/webp', bytes: kept.bytes };
}

/**
 * The image at `sourceUrl`, from Clarity's cache, fetching it first when the
 * cache has no fresh copy. `undefined` when the image cannot be served.
 */
export async function readCachedImage(
  sourceUrl: string,
  now = Date.now(),
): Promise<CachedImage | undefined> {
  if (!hostOf(sourceUrl)) return undefined;
  const key = imageKey(sourceUrl);
  const [row] = await getDb().select().from(imageCache).where(eq(imageCache.key, key)).limit(1);

  if (row) {
    const age = now - row.fetchedAt.getTime();
    if (row.status === 'ready' && row.contentType && row.bytes && age < IMAGE_REFRESH_MS) {
      if (row.rendition < STORED_IMAGE_RENDITION) {
        // Kept by an older pipeline — possibly the site's original. Never
        // served as is: rendered now, and the rendition replaces it. Bytes
        // that do not render were dropped; they are fetched again below.
        const rendered = await rerender(key, row.bytes, now, true);
        if (rendered) return rendered;
      } else {
        if (now - row.lastAccessedAt.getTime() > ACCESS_TOUCH_MS) {
          await getDb()
            .update(imageCache)
            .set({ lastAccessedAt: new Date(now) })
            .where(eq(imageCache.key, key));
        }
        return { contentType: 'image/webp', bytes: row.bytes };
      }
    } else if (row.status === 'missing' && age < IMAGE_MISS_TTL_MS) {
      return undefined;
    }
  }

  let flight = inFlight.get(key);
  if (!flight) {
    flight = fetchAndStore(key, sourceUrl, now).finally(() => inFlight.delete(key));
    inFlight.set(key, flight);
  }
  return flight;
}

/**
 * Replace a row kept by an older pipeline with the current rendition of its
 * bytes. Bytes that do not render are DELETED, not remembered as a miss: the
 * old pipeline asked for AVIF, which many image CDNs (imgix, Hearst, Le Monde,
 * NRK) then served even for a `.jpg` URL, and `Bun.Image` cannot decode it on
 * Linux. The same URL fetched with today's `Accept` returns a format it can, so
 * the next read fetches it afresh instead of showing no image for a miss
 * window. The original is never kept either way.
 */
async function rerender(
  key: string,
  bytes: Buffer,
  now: number,
  /** A read touches the row's access time; the worker's sweep must not. */
  read: boolean,
): Promise<CachedImage | undefined> {
  const image = await renderStoredImage(bytes);
  // Only a row still holding the legacy bytes: a concurrent fetch may have
  // replaced it with a rendition already.
  const legacy = and(eq(imageCache.key, key), lt(imageCache.rendition, STORED_IMAGE_RENDITION));
  if (!image) {
    await getDb().delete(imageCache).where(legacy);
    return undefined;
  }
  await getDb()
    .update(imageCache)
    .set({
      contentType: image.contentType,
      bytes: image.bytes,
      byteSize: image.bytes.length,
      rendition: STORED_IMAGE_RENDITION,
      ...(read ? { lastAccessedAt: new Date(now) } : {}),
    })
    .where(legacy);
  return image;
}

/**
 * Re-render up to `limit` rows kept by an older pipeline (original bytes from
 * before renditions existed, or an older rendition). Run by the worker in
 * small batches, so the backlog drains without one long statement or a burst
 * of reads; returns how many rows it rewrote or dropped.
 */
export async function upgradeImageRenditions(limit: number, now = Date.now()): Promise<number> {
  const rows = await getDb()
    .select({ key: imageCache.key, bytes: imageCache.bytes })
    .from(imageCache)
    .where(and(eq(imageCache.status, 'ready'), lt(imageCache.rendition, STORED_IMAGE_RENDITION)))
    .limit(limit);
  for (const row of rows) {
    if (row.bytes) await rerender(row.key, row.bytes, now, false);
  }
  return rows.length;
}

/**
 * Delete the images nobody has asked for in {@link IMAGE_IDLE_TTL_MS}, and the
 * remembered failures whose window has passed. Run by the worker; returns how
 * many rows went.
 */
export async function sweepImageCache(now = Date.now()): Promise<number> {
  const idleBefore = new Date(now - IMAGE_IDLE_TTL_MS);
  const missBefore = new Date(now - IMAGE_MISS_TTL_MS);
  let removed = 0;
  for (;;) {
    const rows = await getDb().execute<{ key: string }>(sql`
      delete from ${imageCache} where ${imageCache.key} in (
        select ${imageCache.key} from ${imageCache}
        where ${or(
          lt(imageCache.lastAccessedAt, idleBefore),
          and(eq(imageCache.status, 'missing'), lt(imageCache.fetchedAt, missBefore)),
        )}
        limit ${SWEEP_BATCH}
      ) returning ${imageCache.key} as key`);
    const count = Array.isArray(rows) ? rows.length : 0;
    removed += count;
    if (count < SWEEP_BATCH) return removed;
  }
}
