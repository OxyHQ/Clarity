import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../../../db/index.js';
import { productFeedRecords, productFeeds } from '../../../../db/schema/index.js';

/**
 * A product feed's whole life against a real database, with the network
 * replaced at `politeRead` (robots.txt and pacing are the job feeds' own,
 * proven there): registration is idempotent on the canonical source, a poll
 * stores documents and moves `changedAt` only when one changes, a finished walk
 * prunes what the store stopped listing, an EMPTY fresh walk prunes nothing,
 * and records page by external id.
 */

const pages = new Map<string, string>();
vi.mock('../../../jobs/feeds/poll.js', () => ({
  politeRead: vi.fn(async (request: { url: string }) => {
    const body = pages.get(request.url);
    if (body === undefined) throw new Error(`feed responded 404`);
    return body;
  }),
}));

const { listProductFeedRecords, pollProductFeed, registerProductFeed } = await import(
  '../feeds.js'
);

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const DOMAIN = `feeds-${Date.now()}.example`;
const META = `https://${DOMAIN}/meta.json`;
const PAGE_1 = `https://${DOMAIN}/products.json?limit=250&page=1`;

function serve(products: Array<Record<string, unknown>>): void {
  pages.set(META, JSON.stringify({ name: 'Feeds Shop', currency: 'EUR', country: 'ES' }));
  pages.set(PAGE_1, JSON.stringify({ products }));
}

async function feedRow(id: string) {
  const [row] = await getDb().select().from(productFeeds).where(eq(productFeeds.id, id));
  if (!row) throw new Error('feed missing');
  return row;
}

suite('product feeds (postgres)', () => {
  let feedId = '';

  beforeAll(async () => {
    connectPostgres(databaseUrl);
  });

  afterAll(async () => {
    if (feedId) await getDb().delete(productFeeds).where(eq(productFeeds.id, feedId));
    await closePostgres();
  });

  beforeEach(() => pages.clear());

  it('registers a source once, in its canonical spelling', async () => {
    const first = await registerProductFeed({
      kind: 'shopify_storefront',
      identifier: `https://${DOMAIN.toUpperCase()}/`,
    });
    const again = await registerProductFeed({ kind: 'shopify_storefront', identifier: DOMAIN });
    feedId = first.id;
    expect(again.id).toBe(first.id);
    expect(first.identifier).toBe(DOMAIN);
    expect(first.lastCompletedAt).toBeNull();
    await expect(
      registerProductFeed({ kind: 'shopify_storefront', identifier: 'nope' }),
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  it('stores what the store lists, then prunes what it stopped listing', async () => {
    serve([
      { id: 1, title: 'A' },
      { id: 2, title: 'B' },
    ]);
    const first = await pollProductFeed(await feedRow(feedId));
    expect(first).toEqual({ stored: 2, complete: true });
    const stored = await listProductFeedRecords(feedId);
    expect(stored.records.map((record) => record.externalId)).toEqual(['1', '2']);
    expect(stored.feed.meta).toMatchObject({ currency: 'EUR' });
    expect(stored.feed.lastCompletedAt).not.toBeNull();
    const changedBefore = stored.records[0]?.changedAt;

    // Product 1 unchanged, product 2 withdrawn, product 3 new.
    serve([
      { id: 1, title: 'A' },
      { id: 3, title: 'C' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await pollProductFeed(await feedRow(feedId));
    const after = await listProductFeedRecords(feedId);
    expect(after.records.map((record) => record.externalId)).toEqual(['1', '3']);
    expect(after.records[0]?.changedAt).toBe(changedBefore);
    expect(after.feed.recordsSeen).toBe(2);
  });

  it('prunes nothing when a fresh walk finds no products at all', async () => {
    serve([]);
    const outcome = await pollProductFeed(await feedRow(feedId));
    expect(outcome).toEqual({ stored: 0, complete: true });
    const page = await listProductFeedRecords(feedId);
    expect(page.records).toHaveLength(2);
    expect(page.feed.lastError).toMatch(/nothing was pruned/u);
  });

  it('pages by external id with a cursor it issued', async () => {
    const first = await listProductFeedRecords(feedId, { limit: 1 });
    expect(first.records.map((record) => record.externalId)).toEqual(['1']);
    expect(first.nextCursor).not.toBeNull();
    const second = await listProductFeedRecords(feedId, {
      limit: 1,
      cursor: first.nextCursor ?? '',
    });
    expect(second.records.map((record) => record.externalId)).toEqual(['3']);
    expect(second.nextCursor).toBeNull();
    const rows = await getDb()
      .select()
      .from(productFeedRecords)
      .where(eq(productFeedRecords.feedId, feedId));
    expect(rows).toHaveLength(2);
  });
});
