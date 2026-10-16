import { Readable } from 'node:stream';
import { and, eq, inArray, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
import {
  imageCache,
  imageReferences,
  legacyImageReads,
  oxyFileReferenceOutbox,
} from '../../db/schema/index.js';
import { flushLegacyReads } from '../../files/legacy-reads.js';
import { setOxyFilesForTesting } from '../../files/oxy-files.js';
import { FakeOxyFiles, oxyError } from '../../files/__tests__/fake-oxy-files.js';
import {
  IMAGE_IDLE_TTL_MS,
  IMAGE_MISS_TTL_MS,
  IMAGE_REFRESH_MS,
  imageKey,
  imageVersion,
  publicImageUrl,
  resolveImage,
  sweepImageCache,
} from '../image-cache.js';

/**
 * The image cache against real Postgres and a fake Oxy: an image is imported
 * into Oxy once and redirected to from then on, its use by each entity is
 * recorded (and owed to Oxy through the outbox), a failure is remembered
 * briefly, Oxy being down is never remembered, a source Oxy will not fetch is
 * fetched and uploaded by Clarity, a changed image moves every use, and a copy
 * Clarity kept before the move is still served — and counted — during the soak.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]);
const url = (name: string) => `https://ict-images.example/${name}`;
const doc = (name: string) => ({ entityType: 'search_document' as const, entityId: `ict-${name}` });

function answer(status: number, body: Buffer | string, finalUrl: string) {
  return { status, headers: {}, finalUrl, response: Readable.from([Buffer.from(body)]) };
}

async function cleanup(): Promise<void> {
  await getDb().delete(imageCache).where(like(imageCache.sourceUrl, '%ict-images.example%'));
  await getDb().delete(imageReferences).where(like(imageReferences.entityId, 'ict-%'));
  await getDb()
    .delete(oxyFileReferenceOutbox)
    .where(like(oxyFileReferenceOutbox.entityId, 'ict-%'));
}

async function outboxOf(entityId: string) {
  return getDb()
    .select({ op: oxyFileReferenceOutbox.op, file: oxyFileReferenceOutbox.oxyFileId })
    .from(oxyFileReferenceOutbox)
    .where(eq(oxyFileReferenceOutbox.entityId, entityId))
    .orderBy(oxyFileReferenceOutbox.id);
}

suite('image cache on Postgres and Oxy Files', () => {
  let oxy: FakeOxyFiles;

  beforeAll(async () => {
    connectPostgres(databaseUrl);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    setOxyFilesForTesting(undefined);
    await closePostgres();
  });

  beforeEach(() => {
    safeFetch.mockReset();
    oxy = new FakeOxyFiles();
    setOxyFilesForTesting(oxy);
  });

  afterEach(cleanup);

  it('imports an image into Oxy once, with the use, and redirects to it after', async () => {
    oxy.remote.set(url('a.png'), PNG);

    const first = await resolveImage(doc('a'), url('a.png'));
    const second = await resolveImage(doc('a'), url('a.png'));

    expect(first).toEqual({ kind: 'oxy', oxyFileId: 'file-1' });
    expect(second).toEqual(first);
    expect(oxy.calls.filter((call) => call.startsWith('import'))).toEqual(['import:first']);
    // Oxy registered the use in the import itself.
    expect(oxy.referencesOf('search_document', 'ict-a')).toEqual(['file-1']);
    const [row] = await getDb()
      .select()
      .from(imageCache)
      .where(eq(imageCache.key, imageKey(url('a.png'))));
    expect(row).toMatchObject({ status: 'ready', oxyFileId: 'file-1', bytes: null });
    const [use] = await getDb()
      .select()
      .from(imageReferences)
      .where(eq(imageReferences.entityId, 'ict-a'));
    expect(use).toMatchObject({ oxyFileId: 'file-1', imageKey: imageKey(url('a.png')) });
    // The trigger owes Oxy the same use (answered `exists` when drained).
    expect(await outboxOf('ict-a')).toEqual([{ op: 'add', file: 'file-1' }]);
  });

  it('shares one import between concurrent misses, and records each entity', async () => {
    oxy.remote.set(url('shared.png'), PNG);

    const results = await Promise.all([
      resolveImage(doc('s1'), url('shared.png')),
      resolveImage(doc('s2'), url('shared.png')),
      resolveImage(doc('s3'), url('shared.png')),
    ]);

    expect(results.every((r) => r.kind === 'oxy' && r.oxyFileId === 'file-1')).toBe(true);
    expect(oxy.calls.filter((call) => call.startsWith('import'))).toHaveLength(1);
    for (const id of ['ict-s1', 'ict-s2', 'ict-s3'])
      expect(oxy.referencesOf('search_document', id)).toEqual(['file-1']);
  });

  it('remembers a failed source for a while, but never an unreachable Oxy', async () => {
    expect(await resolveImage(doc('b'), url('broken.png'))).toEqual({ kind: 'none' });
    expect(await resolveImage(doc('b'), url('broken.png'))).toEqual({ kind: 'none' });
    expect(oxy.calls.filter((call) => call.startsWith('import'))).toHaveLength(1);
    const later = Date.now() + IMAGE_MISS_TTL_MS + 1000;
    await resolveImage(doc('b'), url('broken.png'), later);
    expect(oxy.calls.filter((call) => call.startsWith('import'))).toHaveLength(2);

    oxy.down = oxyError(503, 'SERVICE_UNAVAILABLE');
    expect(await resolveImage(doc('c'), url('down.png'))).toEqual({ kind: 'unavailable' });
    const rows = await getDb()
      .select()
      .from(imageCache)
      .where(eq(imageCache.key, imageKey(url('down.png'))));
    expect(rows).toEqual([]);
  });

  it('fetches, renders and uploads a source Oxy will not fetch itself', async () => {
    const plain = 'http://ict-images.example/plain.jpg';
    safeFetch.mockResolvedValueOnce(answer(200, JPEG, plain));

    const answered = await resolveImage(doc('h'), plain);

    expect(answered.kind).toBe('oxy');
    expect(oxy.calls).toContain('upload:image/webp');
    const stored = [...oxy.files.values()][0];
    // The rendition, never the site's own bytes.
    expect(stored.bytes.equals(Buffer.concat([Buffer.from('webp:'), JPEG]))).toBe(true);
    expect(oxy.referencesOf('search_document', 'ict-h')).toEqual([stored.id]);

    // A mislabelled https image (Oxy answers 415) takes the same path.
    oxy.remote.set(url('label.png'), oxyError(415, 'UNSUPPORTED_MEDIA_TYPE'));
    safeFetch.mockResolvedValueOnce(answer(200, PNG, url('label.png')));
    expect((await resolveImage(doc('l'), url('label.png'))).kind).toBe('oxy');
  });

  it('restores a released file with a use, and re-imports one Oxy deleted', async () => {
    oxy.remote.set(url('idle.png'), PNG);
    const first = await resolveImage(doc('i'), url('idle.png'));
    if (first.kind !== 'oxy') throw new Error('expected an Oxy file');

    // Released after 30 idle days, then trashed by Oxy: the next request's use
    // brings it back before the redirect.
    await getDb().delete(imageReferences).where(eq(imageReferences.entityId, 'ict-i'));
    oxy.refs.clear();
    oxy.trash(first.oxyFileId);
    expect(await resolveImage(doc('i'), url('idle.png'))).toEqual(first);
    expect(oxy.files.get(first.oxyFileId)?.status).toBe('active');

    // Purged: the use is refused, the row forgotten, the image imported again.
    await getDb().delete(imageReferences).where(eq(imageReferences.entityId, 'ict-i'));
    oxy.purge(first.oxyFileId);
    const again = await resolveImage(doc('i'), url('idle.png'));
    expect(again.kind).toBe('oxy');
    expect(again).not.toEqual(first);
  });

  it('revalidates a stale image and moves every use to a changed one', async () => {
    oxy.remote.set(url('r.png'), PNG);
    await resolveImage(doc('r1'), url('r.png'));
    await resolveImage(doc('r2'), url('r.png'));

    oxy.remote.set(url('r.png'), PNG2);
    const later = Date.now() + IMAGE_REFRESH_MS + 1000;
    const refreshed = await resolveImage(doc('r1'), url('r.png'), later);

    expect(refreshed).toEqual({ kind: 'oxy', oxyFileId: 'file-2' });
    expect(oxy.calls).toContain('import:revalidate');
    const uses = await getDb()
      .select({ id: imageReferences.entityId, file: imageReferences.oxyFileId })
      .from(imageReferences)
      .where(inArray(imageReferences.entityId, ['ict-r1', 'ict-r2']))
      .orderBy(imageReferences.entityId);
    expect(uses).toEqual([
      { id: 'ict-r1', file: 'file-2' },
      { id: 'ict-r2', file: 'file-2' },
    ]);
    expect(await outboxOf('ict-r2')).toEqual([
      { op: 'add', file: 'file-1' },
      { op: 'remove', file: 'file-1' },
      { op: 'add', file: 'file-2' },
    ]);
  });

  it('keeps the file it had when a refresh fails', async () => {
    oxy.remote.set(url('keep.png'), PNG);
    const first = await resolveImage(doc('k'), url('keep.png'));
    oxy.remote.set(url('keep.png'), oxyError(502, 'SOURCE_FETCH_FAILED'));

    const later = Date.now() + IMAGE_REFRESH_MS + 1000;
    expect(await resolveImage(doc('k'), url('keep.png'), later)).toEqual(first);
  });

  it('serves and counts a copy Clarity kept before the move, and hides a blocked one', async () => {
    const legacy = url('legacy.png');
    await getDb()
      .insert(imageCache)
      .values({
        key: imageKey(legacy),
        sourceUrl: legacy,
        status: 'ready',
        contentType: 'image/webp',
        bytes: Buffer.from('webp:kept'),
        byteSize: 9,
        rendition: 1,
      });
    const day = new Date().toISOString().slice(0, 10);
    await getDb()
      .delete(legacyImageReads)
      .where(and(eq(legacyImageReads.day, day), eq(legacyImageReads.surface, 'images')));

    const served = await resolveImage(doc('legacy'), legacy);

    expect(served).toEqual({
      kind: 'legacy',
      image: { contentType: 'image/webp', bytes: Buffer.from('webp:kept') },
    });
    expect(oxy.calls).toEqual([]);
    await flushLegacyReads();
    const [count] = await getDb()
      .select()
      .from(legacyImageReads)
      .where(and(eq(legacyImageReads.day, day), eq(legacyImageReads.surface, 'images')));
    expect(count.reads).toBeGreaterThanOrEqual(1);

    const blocked = url('blocked.png');
    await getDb()
      .insert(imageCache)
      .values({ key: imageKey(blocked), sourceUrl: blocked, status: 'blocked', oxyFileId: 'x' });
    expect(await resolveImage(doc('blocked'), blocked)).toEqual({ kind: 'none' });
  });

  it('sweeps expired failures, idle legacy copies and long-unused mappings only', async () => {
    const now = Date.now();
    const old = new Date(now - IMAGE_IDLE_TTL_MS - 62 * 24 * 60 * 60 * 1000);
    const rows = [
      { name: 'miss-old', status: 'missing', fetchedAt: old, lastAccessedAt: old },
      {
        name: 'legacy-idle',
        status: 'ready',
        contentType: 'image/webp',
        bytes: Buffer.from('x'),
        lastAccessedAt: old,
      },
      { name: 'oxy-unused', status: 'ready', oxyFileId: 'f-unused', lastAccessedAt: old },
      { name: 'oxy-used', status: 'ready', oxyFileId: 'f-used', lastAccessedAt: old },
      { name: 'oxy-fresh', status: 'ready', oxyFileId: 'f-fresh' },
    ];
    for (const { name, ...row } of rows)
      await getDb()
        .insert(imageCache)
        .values({ key: imageKey(url(name)), sourceUrl: url(name), ...row });
    await getDb()
      .insert(imageReferences)
      .values({
        entityType: 'search_document',
        entityId: 'ict-used',
        oxyFileId: 'f-used',
        imageKey: imageKey(url('oxy-used')),
      });

    await sweepImageCache(now);

    const left = await getDb()
      .select({ key: imageCache.key })
      .from(imageCache)
      .where(like(imageCache.sourceUrl, '%ict-images.example%'));
    expect(new Set(left.map((row) => row.key))).toEqual(
      new Set([imageKey(url('oxy-used')), imageKey(url('oxy-fresh'))]),
    );
  });

  it('hands out a stable, versioned Clarity address', () => {
    expect(publicImageUrl('documents', 'd1', url('v.png'))).toBe(
      `https://api.clarity.surf/images/documents/d1/${imageVersion(url('v.png'))}`,
    );
    expect(publicImageUrl('jobs', 'j1', 'ftp://nope')).toBeUndefined();
  });
});
