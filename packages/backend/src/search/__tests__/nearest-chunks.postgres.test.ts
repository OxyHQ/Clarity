import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { searchDocuments } from '../../db/schema/index.js';
import { replaceDocumentChunks, storeChunkEmbeddings } from '../chunking.js';
import { backfillInt8Pages, backfillInt8Vectors } from '../int8-backfill.js';
import { nearestChunks, nearestChunksOrDegrade } from '../nearest-chunks.js';

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

  describe('the int8 and code reranks', () => {
    const HOST = 'https://nearest-by-code.example';
    const direction = (seed: number) =>
      Array.from({ length: 1024 }, (_, index) => Math.sin((index + 1) * seed));
    const query = direction(1);

    afterAll(async () => {
      await getDb().execute(
        sql`delete from clarity_search_documents where canonical_url like ${`${HOST}/%`}`,
      );
    });

    /** A one-chunk document embedded with `vector`, its vector written or not. */
    async function documentNear(vector: number[], storeVectors: boolean) {
      const url = `${HOST}/${crypto.randomUUID()}`;
      const id = crypto.randomUUID();
      await getDb().insert(searchDocuments).values({
        id,
        requestedUrl: url,
        canonicalUrl: url,
        status: 'indexed',
        mainContent: 'one chunk',
        indexedAt: new Date(),
      });
      await replaceDocumentChunks(
        getDb(),
        id,
        [{ start: 0, end: 9, text: 'one chunk' }],
        undefined,
        'nearest-by-code-v1',
      );
      const [chunk] = await getDb().execute<{ id: string }>(
        sql`select id from clarity_search_chunks where document_id = ${id}`,
      );
      await storeChunkEmbeddings(
        [{ id: chunk.id, text: 'one chunk' }],
        [vector],
        getDb(),
        storeVectors,
      );
      return { id, chunkId: chunk.id };
    }

    it('writes no vector when the deployment stores none, and still finds the chunk', async () => {
      // The query itself, a chunk a little off it, and one far from it.
      const same = await documentNear(query, false);
      const near = await documentNear(
        query.map((value, index) => (index % 7 === 0 ? -value : value)),
        false,
      );
      const far = await documentNear(direction(2.3), false);
      const [stored] = await getDb().execute<{ vectors: number; codes: number }>(sql`
        select
          (select count(*) from clarity_search_chunk_vectors where chunk_id in (${same.chunkId}, ${near.chunkId}, ${far.chunkId}))::int as vectors,
          (select count(*) from clarity_search_chunk_embeddings where chunk_id in (${same.chunkId}, ${near.chunkId}, ${far.chunkId}))::int as codes`);
      expect(stored).toEqual({ vectors: 0, codes: 3 });

      for (const rerank of ['int8', 'codes'] as const) {
        const found = await getDb().transaction((tx) => nearestChunks(tx, query, 50, rerank));
        const rank = (id: string) => found.documentIds.indexOf(id);
        expect(rank(same.id)).toBeGreaterThanOrEqual(0);
        expect(rank(same.id)).toBeLessThan(rank(near.id));
        expect([...found.distances]).toEqual([...found.distances].sort((a, b) => a - b));
      }
      const found = await getDb().transaction((tx) => nearestChunks(tx, query, 50, 'codes'));
      const rank = (id: string) => found.documentIds.indexOf(id);
      expect(rank(same.id)).toBeGreaterThanOrEqual(0);
      expect(rank(same.id)).toBeLessThan(rank(near.id));
      expect(rank(near.id)).toBeLessThan(
        rank(far.id) === -1 ? Number.POSITIVE_INFINITY : rank(far.id),
      );
      expect([...found.distances]).toEqual([...found.distances].sort((a, b) => a - b));
      // The vector rerank finds only chunks with a vector: none of these.
      const byVector = await getDb().transaction((tx) => nearestChunks(tx, query, 50, 'vectors'));
      expect(byVector.documentIds).not.toContain(same.id);
    });

    it('orders as the vector rerank does when the vectors are there', async () => {
      const same = await documentNear(query, true);
      const far = await documentNear(direction(3.7), true);
      for (const rerank of ['vectors', 'int8', 'codes'] as const) {
        const found = await getDb().transaction((tx) => nearestChunks(tx, query, 50, rerank));
        expect(found.documentIds.indexOf(same.id)).toBeLessThan(found.documentIds.indexOf(far.id));
      }
    });

    it('writes the int8 vector of every embedded chunk, and orders a chunk without one by its half', async () => {
      const same = await documentNear(query, true);
      const near = await documentNear(
        query.map((value, index) => (index % 5 === 0 ? -value : value)),
        true,
      );
      const [{ int8 }] = await getDb().execute<{ int8: number }>(sql`
        select count(*)::int as int8 from clarity_search_chunk_int8_vectors
        where chunk_id in (${same.chunkId}, ${near.chunkId})`);
      expect(int8).toBe(2);
      // The nearer chunk has only its half (the backfill has not reached it).
      await getDb().execute(
        sql`delete from clarity_search_chunk_int8_vectors where chunk_id = ${same.chunkId}`,
      );
      const found = await getDb().transaction((tx) => nearestChunks(tx, query, 50, 'int8'));
      expect(found.documentIds.indexOf(same.id)).toBeGreaterThanOrEqual(0);
      expect(found.documentIds.indexOf(same.id)).toBeLessThan(found.documentIds.indexOf(near.id));
    });

    it('backfills the int8 vectors a new embedding would write, and nothing twice', async () => {
      const first = await documentNear(direction(1.7), true);
      const second = await documentNear(direction(4.1), true);
      const ids = [first.chunkId, second.chunkId];
      const written = await getDb().execute<{ chunkId: string; vector: string }>(sql`
        select chunk_id as "chunkId", encode(vector, 'hex') as vector
        from clarity_search_chunk_int8_vectors where chunk_id = any(${sql.param(ids)}::text[])
        order by chunk_id`);
      await getDb().execute(
        sql`delete from clarity_search_chunk_int8_vectors where chunk_id = any(${sql.param(ids)}::text[])`,
      );
      const log: string[] = [];
      const run = await backfillInt8Vectors(getDb(), {
        pagesPerBatch: 1,
        dutyCycle: 1,
        log: (event) => log.push(event),
      });
      expect(run.inserted).toBeGreaterThanOrEqual(2);
      expect(log).toContain('done');
      const backfilled = await getDb().execute<{ chunkId: string; vector: string }>(sql`
        select chunk_id as "chunkId", encode(vector, 'hex') as vector
        from clarity_search_chunk_int8_vectors where chunk_id = any(${sql.param(ids)}::text[])
        order by chunk_id`);
      expect(backfilled).toEqual(written);
      // Again: every chunk has one, so nothing is read or written.
      const [{ pages }] = await getDb().execute<{ pages: number }>(sql`
        select (pg_relation_size('clarity_search_chunk_vectors') / 8192)::int as pages`);
      expect(await backfillInt8Pages(getDb(), 0, pages + 1)).toEqual({ read: 0, inserted: 0 });
    });
  });
});
