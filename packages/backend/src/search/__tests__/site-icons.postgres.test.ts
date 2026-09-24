import { Readable } from 'node:stream';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const safeFetch = vi.hoisted(() => vi.fn());
vi.mock('@oxy.so/core/server', () => ({ safeFetch }));

import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { searchHosts } from '../../db/schema/index.js';
import { hostsWithIcons, readSiteIcon, refreshDueIcons, registerHosts } from '../site-icons.js';

/**
 * Site icons against real Postgres: hosts are registered once, a page's
 * declared icon becomes the hint, the worker's claim and outcome land on the
 * row, and a failed refresh never throws away an icon Clarity already had.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const hosts = ['icons-a.example', 'icons-b.example'];

function answer(status: number, body: Buffer | string, finalUrl: string) {
  return { status, headers: {}, finalUrl, response: Readable.from([Buffer.from(body)]) };
}

suite('site icons on Postgres', () => {
  beforeAll(async () => {
    connectPostgres(databaseUrl);
    await getDb().delete(searchHosts).where(inArray(searchHosts.host, hosts));
  });

  afterAll(async () => {
    await getDb().delete(searchHosts).where(inArray(searchHosts.host, hosts));
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

  it('fetches due icons, stores the sniffed image, and serves only what is ready', async () => {
    safeFetch.mockImplementation(async (url: string) =>
      url === 'https://icons-a.example/brand.png' ? answer(200, PNG, url) : answer(404, '', url));

    const outcome = await refreshDueIcons(50);
    expect(outcome.fetched).toBeGreaterThanOrEqual(1);

    const [a] = await getDb().select().from(searchHosts).where(eq(searchHosts.host, 'icons-a.example'));
    const [b] = await getDb().select().from(searchHosts).where(eq(searchHosts.host, 'icons-b.example'));
    expect(a).toMatchObject({ iconStatus: 'ready', iconContentType: 'image/png', iconSourceUrl: 'https://icons-a.example/brand.png' });
    expect(b.iconStatus).toBe('missing');
    expect(a.iconNextFetchAt.getTime()).toBeGreaterThan(Date.now() + 20 * 24 * 60 * 60 * 1000);

    expect(await hostsWithIcons(getDb(), hosts)).toEqual(new Set(['icons-a.example']));
    expect((await readSiteIcon('icons-a.example'))?.bytes.equals(PNG)).toBe(true);
    expect(await readSiteIcon('icons-b.example')).toBeUndefined();
  });

  it('keeps an icon it had when a refresh fails', async () => {
    await getDb().update(searchHosts).set({ iconNextFetchAt: new Date(0) }).where(eq(searchHosts.host, 'icons-a.example'));
    safeFetch.mockImplementation(async (url: string) => answer(503, '', url));

    await refreshDueIcons(50);

    const [a] = await getDb().select().from(searchHosts).where(eq(searchHosts.host, 'icons-a.example'));
    expect(a.iconStatus).toBe('ready');
    expect(a.iconBytes?.equals(PNG)).toBe(true);
  });
});
