import { createHash } from 'node:crypto';
import { and, eq, lt, or, sql } from 'drizzle-orm';

import { getDb } from '../db/index.js';
import { imageCache } from '../db/schema/index.js';
import { fetchBounded, hostOf, publicApiBase, sniffImageType } from './site-icons.js';

/**
 * Remote images served from Clarity: a document's preview image and a job's
 * employer logo.
 *
 * The API never hands a consumer a site's own image URL. It hands out
 * `GET /images/<kind>/<id>/<version>` (routes/images.ts), and Clarity fetches
 * the image itself — through `safeFetch`, SSRF-checked on every hop, capped in
 * size, kept only when its BYTES are an image — and serves its copy. A reader's
 * browser therefore never asks the site for anything, and the site never learns
 * who read what.
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

export interface CachedImage {
  contentType: string;
  bytes: Buffer;
}

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
export function publicImageUrl(kind: ImageKind, id: string, sourceUrl: string | null | undefined): string | undefined {
  if (!sourceUrl || !hostOf(sourceUrl)) return undefined;
  return `${publicApiBase()}/images/${kind}/${encodeURIComponent(id)}/${imageVersion(sourceUrl)}`;
}

async function download(sourceUrl: string): Promise<CachedImage | undefined> {
  const fetched = await fetchBounded(sourceUrl, 'image/avif,image/webp,image/*;q=0.8', MAX_IMAGE_BYTES).catch(() => undefined);
  if (!fetched || fetched.bytes.length === 0) return undefined;
  const contentType = sniffImageType(fetched.bytes);
  return contentType ? { contentType, bytes: fetched.bytes } : undefined;
}

/** Fetches in progress in this process, so concurrent misses share one download. */
const inFlight = new Map<string, Promise<CachedImage | undefined>>();

async function fetchAndStore(key: string, sourceUrl: string, at: number): Promise<CachedImage | undefined> {
  const image = await download(sourceUrl);
  const now = new Date(at);
  const values = image
    ? { status: 'ready', contentType: image.contentType, bytes: image.bytes, byteSize: image.bytes.length }
    : { status: 'missing', contentType: null, bytes: null, byteSize: 0 };
  await getDb().insert(imageCache)
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
  // The refresh failed: serve the previous copy if there is one.
  const [kept] = await getDb().select({ contentType: imageCache.contentType, bytes: imageCache.bytes })
    .from(imageCache).where(and(eq(imageCache.key, key), eq(imageCache.status, 'ready'))).limit(1);
  return kept?.contentType && kept.bytes
    ? { contentType: kept.contentType, bytes: kept.bytes }
    : undefined;
}

/**
 * The image at `sourceUrl`, from Clarity's cache, fetching it first when the
 * cache has no fresh copy. `undefined` when the image cannot be served.
 */
export async function readCachedImage(sourceUrl: string, now = Date.now()): Promise<CachedImage | undefined> {
  if (!hostOf(sourceUrl)) return undefined;
  const key = imageKey(sourceUrl);
  const [row] = await getDb().select().from(imageCache).where(eq(imageCache.key, key)).limit(1);

  if (row) {
    const age = now - row.fetchedAt.getTime();
    if (row.status === 'ready' && row.contentType && row.bytes && age < IMAGE_REFRESH_MS) {
      if (now - row.lastAccessedAt.getTime() > ACCESS_TOUCH_MS) {
        await getDb().update(imageCache).set({ lastAccessedAt: new Date(now) }).where(eq(imageCache.key, key));
      }
      return { contentType: row.contentType, bytes: row.bytes };
    }
    if (row.status === 'missing' && age < IMAGE_MISS_TTL_MS) return undefined;
  }

  let flight = inFlight.get(key);
  if (!flight) {
    flight = fetchAndStore(key, sourceUrl, now).finally(() => inFlight.delete(key));
    inFlight.set(key, flight);
  }
  return flight;
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
