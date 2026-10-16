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
import { type MigrationReportLine, migrateLegacyImages } from '../migrate-legacy-images.js';
import { setOxyFilesForTesting } from '../oxy-files.js';
import { IMAGE_IDLE_TTL_MS } from '../references.js';
import { FakeOxyFiles } from './fake-oxy-files.js';

/**
 * The move of Clarity's own image bytes into Oxy, against real Postgres and a
 * fake Oxy: a preview changes nothing, apply uploads exactly the bytes Clarity
 * serves and checks Oxy stored those, clears the copy, records the uses of
 * entities that still show it, resumes without redoing anything, leaves an SVG
 * icon where it is, and reports content by hash alone.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const WEBP = Buffer.from('webp:current');
const ORIGINAL = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]);
const PNG_ICON = Buffer.from([0x89, 0x50, 0x4e, 0x47, 7]);
const SVG_ICON = Buffer.from('<svg/>');

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
    expect(summary.favicons.would_upload).toBe(1);
    expect(lines.map((l) => l.sha256).sort()).toEqual(
      [sha(WEBP), sha(Buffer.concat([Buffer.from('webp:'), ORIGINAL])), sha(PNG_ICON)].sort(),
    );
    // Content by hash only: never a URL, never a host.
    expect(JSON.stringify(lines)).not.toMatch(/mli\.example|mli-png|https?:/);
    const [row] = await getDb().select().from(imageCache).where(eq(imageCache.key, 'mli-current'));
    expect(row.bytes?.equals(WEBP)).toBe(true);
  });

  it('moves verified copies, records the uses still current, and resumes as a no-op', async () => {
    const lines: MigrationReportLine[] = [];
    const summary = await migrateLegacyImages({ apply: true, report: (l) => lines.push(l), now });

    expect(summary.images.uploaded).toBe(2);
    expect(summary.favicons.uploaded).toBe(1);
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
    expect(svg.iconBytes?.equals(SVG_ICON)).toBe(true);
    expect(svg.iconOxyFileId).toBeNull();

    const uses = await getDb()
      .select({ type: imageReferences.entityType, id: imageReferences.entityId })
      .from(imageReferences)
      .where(like(imageReferences.entityId, 'mli-%'))
      .orderBy(imageReferences.entityId);
    // The document whose image nobody read for 30 days gets no use.
    expect(uses).toEqual([
      { type: 'search_document', id: 'mli-doc-current' },
      { type: 'search_host', id: 'mli-png.example' },
    ]);

    oxy.calls.length = 0;
    const again = await migrateLegacyImages({ apply: true, now });
    expect(again.images).toEqual({});
    expect(again.favicons).toEqual({});
    expect(oxy.calls).toEqual([]);
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
});
