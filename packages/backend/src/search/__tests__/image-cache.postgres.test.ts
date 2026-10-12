import { Readable } from 'node:stream';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const safeFetch = vi.hoisted(() => vi.fn());
vi.mock('@oxy.so/core/server', () => ({ safeFetch }));

/*
 * This suite runs on vitest under Node, which has no `Bun.Image`, so the
 * renderer is a stand-in with the real one's contract: image bytes yield a WebP
 * rendition that is NOT the input, anything else yields nothing. The real
 * renderer is exercised under Bun in image-render.test.ts.
 */
vi.mock('../image-render.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image-render.js')>();
  const isImage = (bytes: Uint8Array) =>
    (bytes[0] === 0x89 && bytes[1] === 0x50) || (bytes[0] === 0xff && bytes[1] === 0xd8);
  return {
    ...actual,
    renderStoredImage: async (bytes: Uint8Array) =>
      isImage(bytes)
        ? { contentType: 'image/webp', bytes: Buffer.concat([Buffer.from('webp:'), bytes]) }
        : undefined,
  };
});

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
  upgradeImageRenditions,
} from '../image-cache.js';
import { STORED_IMAGE_RENDITION } from '../image-render.js';

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
const GIF = Buffer.from('GIF89a-not-renderable');
/** What the stand-in renderer makes of `bytes`. */
const rendered = (bytes: Buffer) => ({
  contentType: 'image/webp',
  bytes: Buffer.concat([Buffer.from('webp:'), bytes]),
});
const urls = [
  'https://images-a.example/cover.png',
  'https://images-b.example/broken.png',
  'https://images-c.example/page.html',
  'https://images-d.example/huge.jpg',
  'https://images-e.example/refresh.jpg',
  'https://images-f.example/legacy.png',
  'https://images-g.example/legacy.gif',
  'https://images-h.example/legacy-unread.png',
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

  it("fetches an image once, then serves Clarity's copy", async () => {
    safeFetch.mockResolvedValueOnce(answer(200, PNG, urls[0]));

    const first = await readCachedImage(urls[0]);
    const second = await readCachedImage(urls[0]);

    expect(first).toEqual(rendered(PNG));
    expect(second).toEqual(rendered(PNG));
    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [row] = await getDb().select().from(imageCache).where(eq(imageCache.key, keys[0]));
    expect(row).toMatchObject({
      status: 'ready',
      sourceUrl: urls[0],
      contentType: 'image/webp',
      byteSize: rendered(PNG).bytes.length,
      rendition: STORED_IMAGE_RENDITION,
    });
    // The site's own bytes are never what is kept.
    expect(Buffer.compare(Buffer.from(row.bytes as Buffer), PNG)).not.toBe(0);
  });

  it('shares one download between concurrent misses', async () => {
    await getDb().delete(imageCache).where(eq(imageCache.key, keys[0]));
    safeFetch.mockResolvedValueOnce(answer(200, PNG, urls[0]));

    const results = await Promise.all([
      readCachedImage(urls[0]),
      readCachedImage(urls[0]),
      readCachedImage(urls[0]),
    ]);

    expect(results.every((image) => image?.contentType === 'image/webp')).toBe(true);
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
    safeFetch.mockResolvedValueOnce(
      answer(200, Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES)]), urls[3]),
    );

    expect(await readCachedImage(urls[3])).toBeUndefined();
  });

  it('refreshes a stale copy, and keeps it when the refresh fails', async () => {
    safeFetch.mockResolvedValueOnce(answer(200, JPEG, urls[4]));
    await readCachedImage(urls[4]);

    const later = Date.now() + IMAGE_REFRESH_MS + 1000;
    safeFetch.mockResolvedValueOnce(answer(500, 'down', urls[4]));
    expect(await readCachedImage(urls[4], later)).toEqual(rendered(JPEG));
    expect(safeFetch).toHaveBeenCalledTimes(2);
    const [row] = await getDb().select().from(imageCache).where(eq(imageCache.key, keys[4]));
    expect(row.status).toBe('ready');

    // The kept copy is NOT treated as fresh for another refresh period: within
    // the miss window it is served as is, and once that passes it is retried.
    safeFetch.mockResolvedValueOnce(answer(200, PNG, urls[4]));
    expect(await readCachedImage(urls[4], later + 60_000)).toEqual(rendered(JPEG));
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(await readCachedImage(urls[4], later + IMAGE_MISS_TTL_MS + 60_000)).toEqual(
      rendered(PNG),
    );
    expect(safeFetch).toHaveBeenCalledTimes(3);
  });

  /** A row as the cache held it before renditions: the site's original bytes. */
  async function legacyRow(index: number, bytes: Buffer, lastAccessedAt = new Date()) {
    await getDb().insert(imageCache).values({
      key: keys[index],
      sourceUrl: urls[index],
      status: 'ready',
      contentType: 'image/png',
      bytes,
      byteSize: bytes.length,
      fetchedAt: new Date(),
      lastAccessedAt,
    });
  }

  it('never serves an original kept before renditions: it renders it on read', async () => {
    await legacyRow(5, PNG);

    expect(await readCachedImage(urls[5])).toEqual(rendered(PNG));
    expect(safeFetch).not.toHaveBeenCalled();
    const [row] = await getDb().select().from(imageCache).where(eq(imageCache.key, keys[5]));
    expect(row).toMatchObject({ rendition: STORED_IMAGE_RENDITION, contentType: 'image/webp' });
    expect(Buffer.from(row.bytes as Buffer)).toEqual(rendered(PNG).bytes);
  });

  it('drops an original that cannot be rendered instead of keeping it', async () => {
    await legacyRow(6, GIF);

    expect(await readCachedImage(urls[6])).toBeUndefined();
    const [row] = await getDb().select().from(imageCache).where(eq(imageCache.key, keys[6]));
    expect(row).toMatchObject({ status: 'missing', bytes: null, byteSize: 0 });
  });

  it('upgrades kept originals in batches without counting it as a read', async () => {
    const idleSince = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await legacyRow(7, JPEG, idleSince);

    let upgraded = 0;
    for (let round = 0; round < 5 && upgraded === 0; round++) {
      const batch = await upgradeImageRenditions(1000);
      if (batch === 0) break;
      const [row] = await getDb().select().from(imageCache).where(eq(imageCache.key, keys[7]));
      if (row.rendition === STORED_IMAGE_RENDITION) upgraded = 1;
    }
    const [row] = await getDb().select().from(imageCache).where(eq(imageCache.key, keys[7]));
    expect(row.rendition).toBe(STORED_IMAGE_RENDITION);
    expect(Buffer.from(row.bytes as Buffer)).toEqual(rendered(JPEG).bytes);
    // Upgraded, not read: an idle image still expires on schedule.
    expect(row.lastAccessedAt.getTime()).toBe(idleSince.getTime());
  });

  it('never fetches a non-HTTP(S) URL', async () => {
    expect(await readCachedImage('file:///etc/passwd')).toBeUndefined();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('sweeps images nobody has asked for, and expired failures, but keeps the rest', async () => {
    await getDb()
      .update(imageCache)
      .set({ lastAccessedAt: new Date(Date.now() - IMAGE_IDLE_TTL_MS - 60_000) })
      .where(eq(imageCache.key, keys[0]));
    await getDb()
      .update(imageCache)
      .set({ fetchedAt: new Date(Date.now() - IMAGE_MISS_TTL_MS - 60_000) })
      .where(eq(imageCache.key, keys[2]));

    await sweepImageCache();

    const left = await getDb()
      .select({ key: imageCache.key })
      .from(imageCache)
      .where(inArray(imageCache.key, keys));
    const leftKeys = new Set(left.map((row) => row.key));
    expect(leftKeys.has(keys[0])).toBe(false);
    expect(leftKeys.has(keys[2])).toBe(false);
    expect(leftKeys.has(keys[4])).toBe(true);
  });
});

describe('public image URLs', () => {
  it('points at Clarity, never at the site', () => {
    const url = publicImageUrl('documents', 'doc-1', 'https://site.example/og.jpg');
    expect(url).toBe(
      `https://api.clarity.surf/images/documents/doc-1/${imageVersion('https://site.example/og.jpg')}`,
    );
    expect(url).not.toContain('site.example');
  });

  it('changes when the source image does', () => {
    expect(publicImageUrl('jobs', 'job-1', 'https://site.example/a.png')).not.toBe(
      publicImageUrl('jobs', 'job-1', 'https://site.example/b.png'),
    );
  });

  it('gives no URL when there is no public image', () => {
    expect(publicImageUrl('documents', 'doc-1', null)).toBeUndefined();
    expect(publicImageUrl('documents', 'doc-1', 'data:image/png;base64,AAAA')).toBeUndefined();
  });
});
