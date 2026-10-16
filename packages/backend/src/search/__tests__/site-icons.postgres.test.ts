import { Readable } from 'node:stream';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const safeFetch = vi.hoisted(() => vi.fn());
vi.mock('@oxy.so/core/server', () => ({ safeFetch }));

import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { imageReferences, oxyFileReferenceOutbox, searchHosts } from '../../db/schema/index.js';
import { setOxyFilesForTesting } from '../../files/oxy-files.js';
import { FakeOxyFiles, oxyError } from '../../files/__tests__/fake-oxy-files.js';
import { hostsWithIcons, readSiteIcon, refreshDueIcons, registerHosts } from '../site-icons.js';

/**
 * Site icons against real Postgres and a fake Oxy: hosts are registered once, a
 * page's declared icon becomes the hint, the worker's claim and outcome land on
 * the row, an icon is kept as a Clarity-owned Oxy file (an SVG stays in
 * Postgres, TODO(oxy-4c)), serving it records the host's use, and a failed
 * refresh never throws away an icon Clarity already had.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const hosts = ['icons-a.example', 'icons-b.example', 'icons-c.example'];
const oxy = new FakeOxyFiles();

function answer(status: number, body: Buffer | string, finalUrl: string) {
  return { status, headers: {}, finalUrl, response: Readable.from([Buffer.from(body)]) };
}

suite('site icons on Postgres', () => {
  async function cleanup() {
    await getDb().delete(searchHosts).where(inArray(searchHosts.host, hosts));
    await getDb().delete(imageReferences).where(inArray(imageReferences.entityId, hosts));
    await getDb()
      .delete(oxyFileReferenceOutbox)
      .where(inArray(oxyFileReferenceOutbox.entityId, hosts));
  }

  beforeAll(async () => {
    connectPostgres(databaseUrl);
    setOxyFilesForTesting(oxy);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    setOxyFilesForTesting(undefined);
    await closePostgres();
  });

  it('registers each host once and keeps the latest declared icon as its hint', async () => {
    await registerHosts(getDb(), [
      { url: 'https://icons-a.example/one' },
      { url: 'https://ICONS-A.example/two', iconHintUrl: 'https://icons-a.example/brand.png' },
      { url: 'https://icons-b.example/' },
      { url: 'ftp://ignored.example/' },
    ]);
    // A later sighting without a hint does not erase the one it had.
    await registerHosts(getDb(), [{ url: 'https://icons-a.example/three' }]);

    const rows = await getDb().select().from(searchHosts).where(inArray(searchHosts.host, hosts));
    expect(rows.map((row) => [row.host, row.iconStatus, row.iconHintUrl]).sort()).toEqual([
      ['icons-a.example', 'pending', 'https://icons-a.example/brand.png'],
      ['icons-b.example', 'pending', null],
    ]);
  });

  it('fetches due icons, keeps the sniffed image in Oxy, and serves only what is ready', async () => {
    safeFetch.mockImplementation(async (url: string) =>
      url === 'https://icons-a.example/brand.png' ? answer(200, PNG, url) : answer(404, '', url),
    );

    const outcome = await refreshDueIcons(50);
    expect(outcome.fetched).toBeGreaterThanOrEqual(1);

    const [a] = await getDb()
      .select()
      .from(searchHosts)
      .where(eq(searchHosts.host, 'icons-a.example'));
    const [b] = await getDb()
      .select()
      .from(searchHosts)
      .where(eq(searchHosts.host, 'icons-b.example'));
    expect(a).toMatchObject({
      iconStatus: 'ready',
      iconContentType: 'image/png',
      iconSourceUrl: 'https://icons-a.example/brand.png',
      iconBytes: null,
    });
    expect(a.iconOxyFileId).toBeTruthy();
    expect(oxy.files.get(a.iconOxyFileId as string)?.bytes.equals(PNG)).toBe(true);
    expect(b.iconStatus).toBe('missing');
    expect(a.iconNextFetchAt.getTime()).toBeGreaterThan(Date.now() + 20 * 24 * 60 * 60 * 1000);

    expect(await hostsWithIcons(getDb(), hosts)).toEqual(new Set(['icons-a.example']));
    expect(await readSiteIcon('icons-a.example')).toEqual({
      kind: 'oxy',
      oxyFileId: a.iconOxyFileId,
    });
    expect(await readSiteIcon('icons-b.example')).toBeUndefined();
    // Serving it recorded the host's use, in Clarity and in Oxy.
    expect(oxy.referencesOf('search_host', 'icons-a.example')).toEqual([a.iconOxyFileId]);
    const [use] = await getDb()
      .select()
      .from(imageReferences)
      .where(eq(imageReferences.entityId, 'icons-a.example'));
    expect(use).toMatchObject({ entityType: 'search_host', oxyFileId: a.iconOxyFileId });
  });

  it('keeps an SVG icon in Postgres, because Oxy cannot hold one yet', async () => {
    await registerHosts(getDb(), [
      { url: 'https://icons-c.example/', iconHintUrl: 'https://icons-c.example/i.svg' },
    ]);
    safeFetch.mockImplementation(async (url: string) =>
      url === 'https://icons-c.example/i.svg' ? answer(200, SVG, url) : answer(404, '', url),
    );

    await refreshDueIcons(50);

    const icon = await readSiteIcon('icons-c.example');
    expect(icon).toMatchObject({ kind: 'local', contentType: 'image/svg+xml' });
    expect(oxy.calls).not.toContain('upload:image/svg+xml');
  });

  it('moves the host to a changed icon, and leaves a host nobody uses alone', async () => {
    const [before] = await getDb()
      .select()
      .from(searchHosts)
      .where(eq(searchHosts.host, 'icons-a.example'));
    await getDb()
      .update(searchHosts)
      .set({ iconNextFetchAt: new Date(0) })
      .where(eq(searchHosts.host, 'icons-a.example'));
    const PNG2 = Buffer.concat([PNG, Buffer.from([7])]);
    safeFetch.mockImplementation(async (url: string) =>
      url === 'https://icons-a.example/brand.png' ? answer(200, PNG2, url) : answer(404, '', url),
    );

    await refreshDueIcons(50);

    const [after] = await getDb()
      .select()
      .from(searchHosts)
      .where(eq(searchHosts.host, 'icons-a.example'));
    expect(after.iconOxyFileId).not.toBe(before.iconOxyFileId);
    const outbox = await getDb()
      .select({ op: oxyFileReferenceOutbox.op, file: oxyFileReferenceOutbox.oxyFileId })
      .from(oxyFileReferenceOutbox)
      .where(eq(oxyFileReferenceOutbox.entityId, 'icons-a.example'))
      .orderBy(oxyFileReferenceOutbox.id);
    expect(outbox.slice(-2)).toEqual([
      { op: 'remove', file: before.iconOxyFileId },
      { op: 'add', file: after.iconOxyFileId },
    ]);

    // Released as unused: due, but not refreshed until somebody asks.
    await getDb().delete(imageReferences).where(eq(imageReferences.entityId, 'icons-a.example'));
    await getDb()
      .update(searchHosts)
      .set({ iconNextFetchAt: new Date(0) })
      .where(eq(searchHosts.host, 'icons-a.example'));
    safeFetch.mockClear();
    await refreshDueIcons(50);
    expect(safeFetch).not.toHaveBeenCalledWith(
      'https://icons-a.example/brand.png',
      expect.anything(),
    );
  });

  it('learns nothing when Oxy cannot take an icon, and tries again soon', async () => {
    await getDb()
      .update(searchHosts)
      .set({ iconNextFetchAt: new Date(0), iconStatus: 'pending', iconOxyFileId: null })
      .where(eq(searchHosts.host, 'icons-b.example'));
    safeFetch.mockImplementation(async (url: string) => answer(200, PNG, url));
    oxy.down = oxyError(503, 'SERVICE_UNAVAILABLE');

    await refreshDueIcons(50);
    oxy.down = undefined;

    const [b] = await getDb()
      .select()
      .from(searchHosts)
      .where(eq(searchHosts.host, 'icons-b.example'));
    expect(b.iconStatus).toBe('pending');
    expect(b.iconNextFetchAt.getTime()).toBeLessThan(Date.now() + 2 * 60 * 60 * 1000);
  });

  it('keeps an icon it had when a refresh fails', async () => {
    await getDb()
      .update(searchHosts)
      .set({ iconNextFetchAt: new Date(0) })
      .where(eq(searchHosts.host, 'icons-c.example'));
    safeFetch.mockImplementation(async (url: string) => answer(503, '', url));

    await refreshDueIcons(50);

    const [c] = await getDb()
      .select()
      .from(searchHosts)
      .where(eq(searchHosts.host, 'icons-c.example'));
    expect(c.iconStatus).toBe('ready');
    expect(c.iconBytes?.equals(SVG)).toBe(true);
  });
});
