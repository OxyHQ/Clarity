import { createHash } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@oxy.so/core/server', () => ({ safeFetch: vi.fn() }));
vi.mock('../../search/image-render.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../search/image-render.js')>();
  return {
    ...actual,
    renderStoredImage: async (bytes: Uint8Array) =>
      bytes[0] === 0x89
        ? { contentType: 'image/webp', bytes: Buffer.concat([Buffer.from('webp:'), bytes]) }
        : undefined,
  };
});

import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import {
  imageCache,
  imageReferences,
  oxyFileReferenceOutbox,
  searchDocuments,
  searchHosts,
} from '../../db/schema/index.js';
import { storageRetirementStatus } from '../legacy-reads.js';
import { type MigrationReportLine, migrateLegacyImages } from '../migrate-legacy-images.js';
import { setOxyFilesForTesting } from '../oxy-files.js';
import { IMAGE_IDLE_TTL_MS } from '../references.js';
import { FakeOxyFiles, oxyError, sanitizeSvg } from './fake-oxy-files.js';

/**
 * The move of Clarity's own image bytes into Oxy, against real Postgres and a
 * fake Oxy: a preview changes nothing, apply uploads exactly the bytes Clarity
 * serves and checks Oxy stored those, clears the copy, records the uses of
 * entities that still show it, resumes without redoing anything, moves an SVG
 * icon into Oxy as its sanitized document (stage 4c) but leaves it where it is
 * when Oxy refuses it, and reports content by hash alone.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const WEBP = Buffer.from('webp:current');
const ORIGINAL = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]);
const PNG_ICON = Buffer.from([0x89, 0x50, 0x4e, 0x47, 7]);
const SVG_ICON = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><path d="M0 0h1"/></svg>',
);
/** No SVG-namespace root: stage 4c refuses it as `INVALID_SVG`. */
const INVALID_SVG_ICON = Buffer.from('<svg><path d="M0 0h1"/></svg>');

async function cleanup(): Promise<void> {
  await getDb().delete(searchDocuments).where(like(searchDocuments.id, 'mli-%'));
  await getDb().delete(imageReferences).where(like(imageReferences.entityId, 'mli-%'));
  await getDb().delete(imageCache).where(like(imageCache.key, 'mli-%'));
  await getDb().delete(searchHosts).where(like(searchHosts.host, 'mli-%'));
  await getDb()
    .delete(oxyFileReferenceOutbox)
    .where(like(oxyFileReferenceOutbox.entityId, 'mli-%'));
}

suite('moving legacy images into Oxy Files', () => {
  let oxy: FakeOxyFiles;
  const now = Date.now();

  beforeAll(async () => {
    connectPostgres(databaseUrl);
  });

  afterAll(async () => {
    await cleanup();
    setOxyFilesForTesting(undefined);
    await closePostgres();
  });

  beforeEach(async () => {
    await cleanup();
    oxy = new FakeOxyFiles();
    setOxyFilesForTesting(oxy);
    const old = new Date(now - IMAGE_IDLE_TTL_MS - 1000);
    await getDb()
      .insert(imageCache)
      .values([
        {
          key: 'mli-current',
          sourceUrl: 'https://mli.example/current.png',
          status: 'ready',
          contentType: 'image/webp',
          bytes: WEBP,
          rendition: 1,
          lastAccessedAt: new Date(now),
        },
        {
          key: 'mli-original',
          sourceUrl: 'https://mli.example/original.png',
          status: 'ready',
          contentType: 'image/png',
          bytes: ORIGINAL,
          rendition: 0,
          lastAccessedAt: old,
        },
      ]);
    await getDb()
      .insert(searchDocuments)
      .values([
        {
          id: 'mli-doc-current',
          requestedUrl: 'https://mli.example/1',
          canonicalUrl: 'https://mli.example/1',
          imageUrl: 'https://mli.example/current.png',
        },
        {
          id: 'mli-doc-original',
          requestedUrl: 'https://mli.example/2',
          canonicalUrl: 'https://mli.example/2',
          imageUrl: 'https://mli.example/original.png',
        },
      ]);
    await getDb()
      .insert(searchHosts)
      .values([
        {
          host: 'mli-png.example',
          iconStatus: 'ready',
          iconContentType: 'image/png',
          iconBytes: PNG_ICON,
        },
        {
          host: 'mli-svg.example',
          iconStatus: 'ready',
          iconContentType: 'image/svg+xml',
          iconBytes: SVG_ICON,
        },
      ]);
  });

  it('previews by hash without writing or calling Oxy', async () => {
    const lines: MigrationReportLine[] = [];
    const summary = await migrateLegacyImages({ apply: false, report: (l) => lines.push(l), now });

    expect(oxy.calls).toEqual([]);
    expect(summary.images.would_upload).toBe(2);
    expect(summary.favicons.would_upload).toBe(2);
    expect(lines.map((l) => l.sha256).sort()).toEqual(
      [
        sha(WEBP),
        sha(Buffer.concat([Buffer.from('webp:'), ORIGINAL])),
        sha(PNG_ICON),
        sha(SVG_ICON),
      ].sort(),
    );
    // Content by hash only: never a URL, never a host.
    expect(JSON.stringify(lines)).not.toMatch(/mli\.example|mli-png|mli-svg|https?:/);
    const [row] = await getDb().select().from(imageCache).where(eq(imageCache.key, 'mli-current'));
    expect(row.bytes?.equals(WEBP)).toBe(true);
  });

  it('moves verified copies, records the uses still current, and resumes as a no-op', async () => {
    const lines: MigrationReportLine[] = [];
    const summary = await migrateLegacyImages({ apply: true, report: (l) => lines.push(l), now });

    expect(summary.images.uploaded).toBe(2);
    expect(summary.favicons.uploaded).toBe(2);
    const cache = await getDb()
      .select()
      .from(imageCache)
      .where(like(imageCache.key, 'mli-%'))
      .orderBy(imageCache.key);
    expect(cache.every((row) => row.bytes === null && row.oxyFileId)).toBe(true);
    // What moved is the rendition Clarity serves, never a kept original.
    const moved = oxy.files.get(cache.find((r) => r.key === 'mli-original')?.oxyFileId as string);
    expect(moved?.bytes.equals(Buffer.concat([Buffer.from('webp:'), ORIGINAL]))).toBe(true);

    const [png] = await getDb()
      .select()
      .from(searchHosts)
      .where(eq(searchHosts.host, 'mli-png.example'));
    const [svg] = await getDb()
      .select()
      .from(searchHosts)
      .where(eq(searchHosts.host, 'mli-svg.example'));
    expect(png).toMatchObject({ iconBytes: null });
    expect(png.iconOxyFileId).toBeTruthy();
    // The SVG moved as the sanitized document Oxy stores, and the report says
    // which hash Oxy holds beside Clarity's.
    expect(svg).toMatchObject({ iconBytes: null, iconStatus: 'ready' });
    const storedSvg = oxy.files.get(svg.iconOxyFileId as string);
    expect(storedSvg?.bytes.equals(sanitizeSvg(SVG_ICON))).toBe(true);
    expect(lines.find((l) => l.sha256 === sha(SVG_ICON))).toMatchObject({
      outcome: 'uploaded',
      oxyFileId: svg.iconOxyFileId,
      storedSha256: sha(sanitizeSvg(SVG_ICON)),
    });

    const uses = await getDb()
      .select({ type: imageReferences.entityType, id: imageReferences.entityId })
      .from(imageReferences)
      .where(like(imageReferences.entityId, 'mli-%'))
      .orderBy(imageReferences.entityId);
    // The document whose image nobody read for 30 days gets no use.
    expect(uses).toEqual([
      { type: 'search_document', id: 'mli-doc-current' },
      { type: 'search_host', id: 'mli-png.example' },
      { type: 'search_host', id: 'mli-svg.example' },
    ]);

    oxy.calls.length = 0;
    const again = await migrateLegacyImages({ apply: true, now });
    expect(again.images).toEqual({});
    expect(again.favicons).toEqual({});
    expect(oxy.calls).toEqual([]);
  });

  it('waits out a 429 and retries the same row, never skipping it', async () => {
    const real = oxy.uploadAppFile.bind(oxy);
    let refusals = 1;
    oxy.uploadAppFile = async (bytes, mime) => {
      if (refusals-- > 0) throw oxyError(429, 'RATE_LIMITED');
      return real(bytes, mime);
    };
    const waits: number[] = [];

    const summary = await migrateLegacyImages({
      apply: true,
      now,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(waits).toEqual([60_000]);
    expect(summary).toMatchObject({
      rateLimited: 1,
      stoppedOnRateLimit: false,
      images: { uploaded: 2 },
      favicons: { uploaded: 2 },
    });
    expect(summary.images.oxy_unavailable).toBeUndefined();
    const legacy = await getDb().select().from(imageCache).where(like(imageCache.key, 'mli-%'));
    expect(legacy.every((row) => row.bytes === null && row.oxyFileId)).toBe(true);
  });

  it('stops on persistent 429s with the rows untouched, and resumes on the next run', async () => {
    const real = oxy.uploadAppFile.bind(oxy);
    let limited = true;
    oxy.uploadAppFile = async (bytes, mime) => {
      if (limited) throw oxyError(429, 'RATE_LIMITED');
      return real(bytes, mime);
    };

    const stopped = await migrateLegacyImages({
      apply: true,
      now,
      maxRateLimitWaits: 2,
      sleep: async () => {},
    });
    expect(stopped).toMatchObject({ stoppedOnRateLimit: true, rateLimited: 3, images: {} });
    const untouched = await getDb().select().from(imageCache).where(like(imageCache.key, 'mli-%'));
    expect(untouched.every((row) => row.bytes !== null && row.oxyFileId === null)).toBe(true);

    limited = false;
    const resumed = await migrateLegacyImages({ apply: true, now });
    expect(resumed).toMatchObject({ images: { uploaded: 2 }, favicons: { uploaded: 2 } });
  });

  it('paces uploads to the rate it is given', async () => {
    const waits: number[] = [];
    await migrateLegacyImages({
      apply: true,
      now,
      perMinute: 2,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    // Four uploads at two a minute: the first goes at once, each later one waits.
    expect(waits).toHaveLength(3);
    expect(waits.every((ms) => ms > 25_000 && ms <= 30_000)).toBe(true);
  });

  it('moves rows sharing bytes onto one verified upload', async () => {
    await getDb().insert(searchHosts).values({
      host: 'mli-png-twin.example',
      iconStatus: 'ready',
      iconContentType: 'image/png',
      iconBytes: PNG_ICON,
    });

    const summary = await migrateLegacyImages({ apply: true, now });

    expect(summary.favicons.uploaded).toBe(3);
    expect(summary.uploadsReused).toBe(1);
    expect(oxy.calls.filter((call) => call === 'upload:image/png')).toHaveLength(1);
    const hosts = await getDb()
      .select({ host: searchHosts.host, file: searchHosts.iconOxyFileId })
      .from(searchHosts)
      .where(like(searchHosts.host, 'mli-png%'));
    expect(new Set(hosts.map((h) => h.file)).size).toBe(1);
    expect(hosts.every((h) => h.file)).toBe(true);
    const uses = await getDb()
      .select({ id: imageReferences.entityId })
      .from(imageReferences)
      .where(like(imageReferences.entityId, 'mli-png%'));
    expect(uses).toHaveLength(2);
  });

  it('leaves a row as it was when Oxy did not store exactly its bytes', async () => {
    const real = oxy.uploadAppFile.bind(oxy);
    oxy.uploadAppFile = async (bytes, mime) => {
      const stored = await real(bytes, mime);
      return { ...stored, file: { ...stored.file, sha256: '0'.repeat(64) } };
    };

    const summary = await migrateLegacyImages({ apply: true, now, limit: 1 });

    expect(summary.images.sha256_mismatch).toBe(1);
    const legacy = await getDb().select().from(imageCache).where(like(imageCache.key, 'mli-%'));
    expect(legacy.every((row) => row.bytes !== null && row.oxyFileId === null)).toBe(true);
  });

  it('leaves an SVG icon served from Postgres when Oxy predates stage 4c', async () => {
    oxy.svg = 'unsupported';
    const summary = await migrateLegacyImages({ apply: true, now });

    expect(summary.favicons).toMatchObject({ uploaded: 1, refused: 1 });
    const [svg] = await getDb()
      .select()
      .from(searchHosts)
      .where(eq(searchHosts.host, 'mli-svg.example'));
    expect(svg.iconBytes?.equals(SVG_ICON)).toBe(true);
    expect(svg).toMatchObject({ iconOxyFileId: null, iconStatus: 'ready' });
    // An SVG still in Postgres blocks the retirement like any other copy.
    const status = await storageRetirementStatus(now);
    expect(status.svgFaviconsNotMigrated).toBeGreaterThanOrEqual(1);
    expect(status.faviconsNotMigrated).toBeGreaterThanOrEqual(status.svgFaviconsNotMigrated);
    expect(status.ready).toBe(false);

    // Once Oxy holds SVG, the same run moves it.
    oxy.svg = 'sanitize';
    const later = await migrateLegacyImages({ apply: true, now });
    expect(later.favicons).toEqual({ uploaded: 1 });
  });

  it('leaves an SVG stage 4c refuses as unsafe, unless asked to release it', async () => {
    await getDb()
      .update(searchHosts)
      .set({ iconBytes: INVALID_SVG_ICON })
      .where(eq(searchHosts.host, 'mli-svg.example'));

    const kept = await migrateLegacyImages({ apply: true, now });
    expect(kept.favicons).toMatchObject({ uploaded: 1, invalid_svg: 1 });
    const [left] = await getDb()
      .select()
      .from(searchHosts)
      .where(eq(searchHosts.host, 'mli-svg.example'));
    expect(left.iconBytes?.equals(INVALID_SVG_ICON)).toBe(true);
    expect(left.iconStatus).toBe('ready');

    const released = await migrateLegacyImages({ apply: true, now, releaseInvalidSvg: true });
    expect(released.favicons).toEqual({ released_invalid_svg: 1 });
    const [gone] = await getDb()
      .select()
      .from(searchHosts)
      .where(eq(searchHosts.host, 'mli-svg.example'));
    expect(gone).toMatchObject({ iconStatus: 'missing', iconBytes: null, iconOxyFileId: null });
    // Due at once: the worker fetches the host's icon again.
    expect(gone.iconNextFetchAt.getTime()).toBeLessThanOrEqual(now);
  });
});
