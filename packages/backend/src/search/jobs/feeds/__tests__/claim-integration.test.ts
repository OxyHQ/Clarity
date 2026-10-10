import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../../../db/index.js';
import { jobFeeds } from '../../../../db/schema/index.js';
import { claimDueFeeds } from '../poll.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;
const ids: string[] = [];

suite('feed claiming (PostgreSQL)', () => {
  beforeAll(async () => {
    connectPostgres(databaseUrl);
    const past = new Date(Date.now() - 60_000);
    const rows = [
      ...['de1', 'de2', 'de3', 'de4'].map((identifier, index) => ({
        kind: 'eures',
        identifier: `claimtest-${identifier}`,
        nextPollAt: new Date(past.getTime() - index * 1000),
      })),
      { kind: 'greenhouse', identifier: 'claimtest-acme', nextPollAt: past },
      {
        kind: 'lever',
        identifier: 'claimtest-later',
        nextPollAt: new Date(Date.now() + 3_600_000),
      },
    ].map((row) => ({ id: crypto.randomUUID(), ...row }));
    ids.push(...rows.map((row) => row.id));
    // Only this test's rows are due: anything else a shared database holds is pushed out of the window first.
    await getDb()
      .update(jobFeeds)
      .set({ nextPollAt: new Date(Date.now() + 86_400_000) });
    await getDb().insert(jobFeeds).values(rows);
  });

  afterAll(async () => {
    await getDb().delete(jobFeeds).where(inArray(jobFeeds.id, ids));
    await closePostgres();
  });

  it('claims the longest-waiting due feeds, at most two per kind, and pushes them out of the window', async () => {
    const claimed = await claimDueFeeds(8);
    const kinds = claimed.map((feed) => feed.kind);
    expect(kinds.filter((kind) => kind === 'eures')).toHaveLength(2);
    expect(kinds).toContain('greenhouse');
    expect(kinds).not.toContain('lever');
    expect(
      claimed
        .filter((feed) => feed.kind === 'eures')
        .map((feed) => feed.identifier)
        .sort(),
    ).toEqual(['claimtest-de3', 'claimtest-de4']);
    // A second worker finds nothing it may take until the claim lapses.
    const again = await claimDueFeeds(8);
    expect(
      again.map((feed) => feed.id).filter((id) => claimed.some((feed) => feed.id === id)),
    ).toEqual([]);
  });
});
