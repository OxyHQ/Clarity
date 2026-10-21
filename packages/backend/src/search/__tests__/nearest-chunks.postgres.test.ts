import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { nearestChunksOrDegrade } from '../nearest-chunks.js';

/**
 * A hybrid search's semantic arm that runs out of time gives the search back
 * its transaction, so the search answers lexically instead of failing.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const embedding = Array.from({ length: 1024 }, (_, index) => ((index % 5) + 1) / 10);

suite('the semantic arm under a deadline on Postgres', () => {
  let other: postgres.Sql;

  beforeAll(() => {
    connectPostgres(databaseUrl);
    other = postgres(databaseUrl, { max: 1 });
  });

  afterAll(async () => {
    await other.end();
    await closePostgres();
  });

  it('gives up past its deadline and leaves the transaction usable', async () => {
    // Another session holds the codes table, so the candidates' read waits —
    // and the wait counts against the statement timeout.
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = other.begin(async (session) => {
      await session`lock table clarity_search_chunk_embeddings in access exclusive mode`;
      locked();
      await released;
    });
    await isLocked;
    try {
      const outcome = await getDb().transaction(async (tx) => {
        await tx.execute(sql.raw('set local statement_timeout = 10000'));
        const nearest = await nearestChunksOrDegrade(tx, embedding, 10, { timeoutMs: 200 });
        const [after] = await tx.execute<{ one: number; timeout: string }>(
          sql`select 1 as one, current_setting('statement_timeout') as timeout`,
        );
        return { nearest, after };
      });
      expect(outcome.nearest).toBeUndefined();
      expect(outcome.after).toEqual({ one: 1, timeout: '10s' });
    } finally {
      release();
      await holder;
    }
  });

  it('restores the ranking its own deadline once it answers', async () => {
    const timeout = await getDb().transaction(async (tx) => {
      await tx.execute(sql.raw('set local statement_timeout = 10000'));
      const nearest = await nearestChunksOrDegrade(tx, embedding, 10);
      expect(nearest).toBeDefined();
      const [row] = await tx.execute<{ timeout: string }>(
        sql`select current_setting('statement_timeout') as timeout`,
      );
      return row?.timeout;
    });
    expect(timeout).toBe('10s');
  });
});
