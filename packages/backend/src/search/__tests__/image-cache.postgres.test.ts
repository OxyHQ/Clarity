import { Readable } from 'node:stream';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const safeFetch = vi.hoisted(() => vi.fn());
vi.mock('@oxy.so/core/server', () => ({ safeFetch }));

import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { imageCache } from '../../db/schema/index.js';
import {
  IMAGE_IDLE_TTL_MS,
  IMAGE_MISS_TTL_MS,
  IMAGE_REFRESH_MS,
  MAX_IMAGE_BYTES,
  imageKey,
  imageVersion,
  publicImageUrl,
  readCachedImage,
  sweepImageCache,
} from '../image-cache.js';

/**
 * The image cache against real Postgres: an image is fetched once and then
 * served from Clarity, a failure is remembered briefly, a failed refresh keeps
 * the copy Clarity had, anything that is not an image is refused, and the sweep
 * deletes what nobody asks for.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]);
const urls = [
  'https://images-a.example/cover.png',
  'https://images-b.example/broken.png',
  'https://images-c.example/page.html',
  'https://images-d.example/huge.jpg',
  'https://images-e.example/refresh.jpg',
];
const keys = urls.map(imageKey);

function answer(status: number, body: Buffer | string, finalUrl: string) {
  return { status, headers: {}, finalUrl, response: Readable.from([Buffer.from(body)]) };
}

suite('image cache on Postgres', () => {
  beforeAll(async () => {
    connectPostgres(databaseUrl);
    await getDb().delete(imageCache).where(inArray(imageCache.key, keys));
  });

  afterAll(async () => {
    await getDb().delete(imageCache).where(inArray(imageCache.key, keys));
    await closePostgres();
  });

  beforeEach(() => safeFetch.mockReset());

  it('fetches an image once, then serves Clarity\'s copy', async () => {
    safeFetch.mockResolvedValueOnce(answer(200, PNG, urls[0]));

    const first = await readCachedImage(urls[0]);
    const second = await readCachedImage(urls[0]);

    expect(first).toEqual({ contentType: 'image/png', bytes: PNG });
    expect(second).toEqual({ contentType: 'image/png', bytes: PNG });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [row] = await getDb().select().from(imageCache).where(eq(imageCache.key, keys[0]));
    expect(row).toMatchObject({ status: 'ready', sourceUrl: urls[0], byteSize: PNG.length });
  });

  it('shares one download between concurrent misses', async () => {
    await getDb().delete(imageCache).where(eq(imageCache.key, keys[0]));
    safeFetch.mockResolvedValueOnce(answer(200, PNG, urls[0]));

    const results = await Promise.all([readCachedImage(urls[0]), readCachedImage(urls[0]), readCachedImage(urls[0])]);

    expect(results.every((image) => image?.contentType === 'image/png')).toBe(true);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it('remembers a failed fetch for a while instead of refetching on every request', async () => {
    safeFetch.mockResolvedValue(answer(404, 'nope', urls[1]));

    expect(await readCachedImage(urls[1])).toBeUndefined();
    expect(await readCachedImage(urls[1])).toBeUndefined();
    expect(safeFetch).toHaveBeenCalledTimes(1);

    // Once the window passes, it is tried again.
    expect(await readCachedImage(urls[1], Date.now() + IMAGE_MISS_TTL_MS + 1000)).toBeUndefined();
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it('refuses anything whose bytes are not an image, whatever the site calls it', async () => {
    safeFetch.mockResolvedValueOnce(answer(200, '<html>not an image</html>', urls[2]));

    expect(await readCachedImage(urls[2])).toBeUndefined();
    const [row] = await getDb().select().from(imageCache).where(eq(imageCache.key, keys[2]));
    expect(row.status).toBe('missing');
  });

  it('refuses an image larger than the cap', async () => {
    safeFetch.mockResolvedValueOnce(answer(200, Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES)]), urls[3]));

    expect(await readCachedImage(urls[3])).toBeUndefined();
  });

  it('refreshes a stale copy, and keeps it when the refresh fails', async () => {
    safeFetch.mockResolvedValueOnce(answer(200, JPEG, urls[4]));
    await readCachedImage(urls[4]);

    const later = Date.now() + IMAGE_REFRESH_MS + 1000;
    safeFetch.mockResolvedValueOnce(answer(500, 'down', urls[4]));
    expect(await readCachedImage(urls[4], later)).toEqual({ contentType: 'image/jpeg', bytes: JPEG });
    expect(safeFetch).toHaveBeenCalledTimes(2);
    const [row] = await getDb().select().from(imageCache).where(eq(imageCache.key, keys[4]));
    expect(row.status).toBe('ready');
  });

  it('never fetches a non-HTTP(S) URL', async () => {
    expect(await readCachedImage('file:///etc/passwd')).toBeUndefined();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('sweeps images nobody has asked for, and expired failures, but keeps the rest', async () => {
    await getDb().update(imageCache)
      .set({ lastAccessedAt: new Date(Date.now() - IMAGE_IDLE_TTL_MS - 60_000) })
      .where(eq(imageCache.key, keys[0]));
    await getDb().update(imageCache)
      .set({ fetchedAt: new Date(Date.now() - IMAGE_MISS_TTL_MS - 60_000) })
      .where(eq(imageCache.key, keys[2]));

    await sweepImageCache();

    const left = await getDb().select({ key: imageCache.key }).from(imageCache).where(inArray(imageCache.key, keys));
    const leftKeys = new Set(left.map((row) => row.key));
    expect(leftKeys.has(keys[0])).toBe(false);
    expect(leftKeys.has(keys[2])).toBe(false);
    expect(leftKeys.has(keys[4])).toBe(true);
  });
});

describe('public image URLs', () => {
  it('points at Clarity, never at the site', () => {
    const url = publicImageUrl('documents', 'doc-1', 'https://site.example/og.jpg');
    expect(url).toBe(`https://api.clarity.surf/images/documents/doc-1/${imageVersion('https://site.example/og.jpg')}`);
    expect(url).not.toContain('site.example');
  });

  it('changes when the source image does', () => {
    expect(publicImageUrl('jobs', 'job-1', 'https://site.example/a.png'))
      .not.toBe(publicImageUrl('jobs', 'job-1', 'https://site.example/b.png'));
  });

  it('gives no URL when there is no public image', () => {
    expect(publicImageUrl('documents', 'doc-1', null)).toBeUndefined();
    expect(publicImageUrl('documents', 'doc-1', 'data:image/png;base64,AAAA')).toBeUndefined();
  });
});
