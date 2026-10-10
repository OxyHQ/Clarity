import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../../../db/index.js';
import { jobFeeds, jobPostings, searchDocuments } from '../../../../db/schema/index.js';
import { ingestJobPosting, pruneInactiveJobDocuments } from '../../projection.js';
import { closeAbsentListings, recordFeedPresence } from '../presence.js';

vi.mock('../../../../lib/oxy-embeddings.js', () => ({
  CLARITY_EMBEDDING_MODEL: 'test-embedding-model',
  createOxyEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => Array.from({ length: 1024 }, () => 0.1))),
}));

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;
const run = crypto.randomUUID().slice(0, 8);
const url = (name: string) => `https://presence-${run}.example/jobs/${name}`;
const feedIds = [crypto.randomUUID(), crypto.randomUUID()];

async function ingest(name: string, observedAt = new Date()): Promise<string> {
  const { documentId } = await ingestJobPosting({
    canonicalUrl: url(name),
    structuredData: [{ '@type': 'JobPosting', title: `Role ${name}`, hiringOrganization: { name: 'Acme' }, url: url(name) }],
    siteId: null, sourceType: 'feed', fieldSource: 'feed', observedAt,
  });
  return documentId;
}

async function statusOf(name: string): Promise<string | undefined> {
  const [row] = await getDb().select({ status: jobPostings.status }).from(jobPostings).where(eq(jobPostings.canonicalUrl, url(name)));
  return row?.status;
}

suite('withdrawal by absence and retention (PostgreSQL)', () => {
  beforeAll(async () => {
    connectPostgres(databaseUrl);
    await getDb().insert(jobFeeds).values([
      { id: feedIds[0], kind: 'greenhouse', identifier: `presence-${run}-a` },
      { id: feedIds[1], kind: 'lever', identifier: `presence-${run}-b` },
    ]);
  });

  afterAll(async () => {
    await getDb().delete(searchDocuments).where(inArray(searchDocuments.canonicalUrl, ['a', 'b', 'c', 'old', 'live'].map(url)));
    await getDb().delete(jobFeeds).where(inArray(jobFeeds.id, feedIds));
    await closePostgres();
  });

  it('closes what a complete feed stopped listing, unless another feed still lists it, and reopens on return', async () => {
    for (const name of ['a', 'b', 'c']) await ingest(name);
    const first = new Date();
    await recordFeedPresence(feedIds[0], ['a', 'b', 'c'].map(url), first);
    await recordFeedPresence(feedIds[1], [url('b')], first);

    const second = new Date(first.getTime() + 1_000);
    await recordFeedPresence(feedIds[0], [url('a')], second);
    expect(await closeAbsentListings(feedIds[0], second)).toBe(1);
    expect(await statusOf('a')).toBe('active');
    expect(await statusOf('b')).toBe('active'); // the other feed still lists it
    expect(await statusOf('c')).toBe('closed');

    await ingest('c');
    expect(await statusOf('c')).toBe('active');
  });

  it('deletes job documents with no active listing and no sighting for the retention window, and nothing else', async () => {
    const old = await ingest('old');
    await ingest('live');
    const longAgo = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    await getDb().update(jobPostings).set({ status: 'closed', closedAt: longAgo, lastSeenAt: longAgo }).where(eq(jobPostings.documentId, old));
    await getDb().update(searchDocuments).set({ fetchedAt: longAgo, updatedAt: longAgo }).where(eq(searchDocuments.id, old));

    let pruned = 0;
    for (let pass = 0; pass < 20; pass += 1) {
      const deleted = await pruneInactiveJobDocuments();
      pruned += deleted;
      if (deleted === 0) break;
    }
    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(await getDb().select().from(searchDocuments).where(eq(searchDocuments.id, old))).toHaveLength(0);
    expect(await statusOf('live')).toBe('active');
  });
});
