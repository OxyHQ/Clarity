import { eq, inArray, sql, TransactionRollbackError } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ClarityExecutor, closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { searchChunkBacklog, searchChunks, searchDocuments } from '../../db/schema/index.js';
import { createEmbeddings, embeddingsEnabled } from '../../lib/kaana-embeddings.js';
import {
  chunkText,
  documentChunkState,
  flushChunkEmbeddingsForTests,
  queueChunkEmbeddings,
  queueEmbeddingBacklog,
  replaceDocumentChunks,
  storeChunkEmbeddings,
} from '../chunking.js';

/**
 * `clarity_search_chunk_embeddings` carries the HNSW index over the binary
 * codes, and every vacuum that finds a dead tuple there walks the whole index
 * (docs/search-storage.md, "Insert-only codes"). So a chunk gets its row only
 * once its code exists, and a chunk still owed one waits in
 * `clarity_search_chunk_backlog`. These tests pin that the embed cycle only
 * ever inserts there.
 */
vi.mock('../../lib/kaana-embeddings.js', () => ({
  CLARITY_EMBEDDING_MODEL: 'test-embedding-model',
  embeddingsEnabled: vi.fn(() => true),
  createEmbeddings: vi.fn(),
}));

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const EXTRACTOR = 'insert-only-codes-test-v1';
const HOST = 'https://insert-only-codes.example';
const body = 'An insert-only body long enough to span a few chunks. '.repeat(120);
const chunks = chunkText(body);
const vector = (seed = 1) => Array.from({ length: 1024 }, (_, i) => ((i * seed) % 11) / 11);

async function indexDocument(
  executor: ClarityExecutor,
  embeddings?: (number[] | undefined)[],
): Promise<{ documentId: string; url: string; chunkIds: string[] }> {
  const url = `${HOST}/${crypto.randomUUID()}`;
  const [document] = await executor
    .insert(searchDocuments)
    .values({
      id: crypto.randomUUID(),
      requestedUrl: url,
      canonicalUrl: url,
      status: 'indexed',
      mainContent: body,
      indexedAt: new Date(),
    })
    .returning();
  await replaceDocumentChunks(
    executor,
    document.id,
    chunks,
    embeddings as number[][] | undefined,
    EXTRACTOR,
  );
  const stored = await executor
    .select({ id: searchChunks.id })
    .from(searchChunks)
    .where(eq(searchChunks.documentId, document.id))
    .orderBy(searchChunks.position);
  return { documentId: document.id, url, chunkIds: stored.map((row) => row.id) };
}

async function rowsOf(executor: ClarityExecutor, chunkIds: readonly string[]) {
  const ids = sql.param(chunkIds);
  const [row] = await executor.execute<{
    backlog: number;
    embeddings: number;
    unembedded: number;
    vectors: number;
  }>(sql`
    select
      (select count(*) from clarity_search_chunk_backlog where chunk_id = any(${ids}::text[]))::int as backlog,
      (select count(*) from clarity_search_chunk_embeddings where chunk_id = any(${ids}::text[]))::int as embeddings,
      (select count(*) from clarity_search_chunk_embeddings
        where chunk_id = any(${ids}::text[]) and (code is null or model is null))::int as unembedded,
      (select count(*) from clarity_search_chunk_vectors where chunk_id = any(${ids}::text[]))::int as vectors`);
  return row;
}

/** xmin and ctid change whenever a row is rewritten, even to the same values. */
async function versions(executor: ClarityExecutor, chunkIds: readonly string[]) {
  return executor.execute<{ chunkId: string; embedding: string; vector: string | null }>(sql`
    select e.chunk_id as "chunkId", e.xmin::text || e.ctid::text as embedding,
      v.xmin::text || v.ctid::text as vector
    from clarity_search_chunk_embeddings e
    left join clarity_search_chunk_vectors v on v.chunk_id = e.chunk_id
    where e.chunk_id = any(${sql.param(chunkIds)}::text[])
    order by e.chunk_id`);
}

/**
 * Tuples this backend inserted, updated and deleted in each table and has not
 * reported yet. Only a difference taken inside one transaction is meaningful:
 * the pending counters also hold earlier transactions on the same connection.
 */
async function writeCounters(executor: ClarityExecutor) {
  const rows = await executor.execute<{
    table: string;
    inserted: number;
    updated: number;
    deleted: number;
  }>(sql`
    select relname as table,
      pg_stat_get_xact_tuples_inserted(oid)::int as inserted,
      pg_stat_get_xact_tuples_updated(oid)::int as updated,
      pg_stat_get_xact_tuples_deleted(oid)::int as deleted
    from pg_class
    where relname in ('clarity_search_chunk_embeddings', 'clarity_search_chunk_backlog',
      'clarity_search_chunk_vectors') and relnamespace = 'public'::regnamespace`);
  return Object.fromEntries(rows.map(({ table, ...counts }) => [table, counts]));
}

async function writesDuring(executor: ClarityExecutor, body: () => Promise<void>) {
  const before = await writeCounters(executor);
  await body();
  const after = await writeCounters(executor);
  return Object.fromEntries(
    Object.entries(after).map(([table, counts]) => [
      table,
      {
        inserted: counts.inserted - (before[table]?.inserted ?? 0),
        updated: counts.updated - (before[table]?.updated ?? 0),
        deleted: counts.deleted - (before[table]?.deleted ?? 0),
      },
    ]),
  );
}

/** Runs `body` in a transaction that is always rolled back. */
async function rolledBack(body: (tx: ClarityExecutor) => Promise<void>): Promise<void> {
  try {
    await getDb().transaction(async (tx) => {
      await body(tx);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
}

suite('insert-only embedding codes on Postgres', () => {
  let other: postgres.Sql;

  beforeAll(async () => {
    connectPostgres(databaseUrl);
    other = postgres(databaseUrl, { max: 1 });
    expect(chunks.length).toBeGreaterThan(2);
  });

  beforeEach(() => {
    vi.mocked(embeddingsEnabled).mockReturnValue(true);
    vi.mocked(createEmbeddings).mockReset();
  });

  afterAll(async () => {
    await getDb()
      .delete(searchDocuments)
      .where(sql`${searchDocuments.canonicalUrl} like ${`${HOST}/%`}`);
    await other.end();
    await closePostgres();
  });

  it('stores an unembedded chunk in the backlog, with no embeddings row', async () => {
    const { chunkIds } = await indexDocument(getDb());
    expect(await rowsOf(getDb(), chunkIds)).toEqual({
      backlog: chunkIds.length,
      embeddings: 0,
      unembedded: 0,
      vectors: 0,
    });
    const backlog = await getDb()
      .select()
      .from(searchChunkBacklog)
      .where(inArray(searchChunkBacklog.chunkId, chunkIds));
    expect(new Set(backlog.map((row) => row.documentId)).size).toBe(1);
  });

  it('stores a chunk given its embedding with its code and vector, and nothing in the backlog', async () => {
    const { chunkIds } = await indexDocument(
      getDb(),
      chunks.map((_, index) => (index === 0 ? undefined : vector())),
    );
    expect(await rowsOf(getDb(), chunkIds)).toEqual({
      backlog: 1,
      embeddings: chunkIds.length - 1,
      unembedded: 0,
      vectors: chunkIds.length - 1,
    });
    const [owed] = await getDb()
      .select({ id: searchChunkBacklog.chunkId })
      .from(searchChunkBacklog)
      .where(inArray(searchChunkBacklog.chunkId, chunkIds));
    expect(owed.id).toBe(chunkIds[0]);
  });

  it('writes the code and vector of an embedded chunk and takes it off the backlog', async () => {
    const { url, chunkIds } = await indexDocument(getDb());
    await storeChunkEmbeddings(
      chunkIds.map((id) => ({ id, text: '' })),
      chunkIds.map(() => vector()),
    );
    expect(await rowsOf(getDb(), chunkIds)).toEqual({
      backlog: 0,
      embeddings: chunkIds.length,
      unembedded: 0,
      vectors: chunkIds.length,
    });
    await expect(documentChunkState(getDb(), url, body, chunks.length, EXTRACTOR)).resolves.toBe(
      'current',
    );
  });

  it('embeds a document without one UPDATE on the codes table', async () => {
    await rolledBack(async (tx) => {
      let chunkIds: string[] = [];
      const counts = await writesDuring(tx, async () => {
        ({ chunkIds } = await indexDocument(tx));
        const queued = chunkIds.map((id) => ({ id, text: '' }));
        await storeChunkEmbeddings(
          queued,
          queued.map(() => vector()),
          tx,
        );
        // Embedded again (a second worker, a re-queued chunk): nothing is rewritten.
        await storeChunkEmbeddings(
          queued,
          queued.map(() => vector()),
          tx,
        );
      });
      expect(counts.clarity_search_chunk_embeddings).toEqual({
        inserted: chunkIds.length,
        updated: 0,
        deleted: 0,
      });
      expect(counts.clarity_search_chunk_vectors).toEqual({
        inserted: chunkIds.length,
        updated: 0,
        deleted: 0,
      });
      expect(counts.clarity_search_chunk_backlog).toEqual({
        inserted: chunkIds.length,
        updated: 0,
        deleted: chunkIds.length,
      });
    });
  });

  it('does not rewrite a chunk already embedded with the current model', async () => {
    const { chunkIds } = await indexDocument(getDb());
    const queued = chunkIds.map((id) => ({ id, text: '' }));
    await storeChunkEmbeddings(
      queued,
      queued.map(() => vector()),
    );
    const before = await versions(getDb(), chunkIds);
    expect(before).toHaveLength(chunkIds.length);
    await storeChunkEmbeddings(
      queued,
      queued.map(() => vector(3)),
    );
    expect(await versions(getDb(), chunkIds)).toEqual(before);
  });

  it('rewrites a chunk embedded by another model, and only that one', async () => {
    const { url, chunkIds } = await indexDocument(getDb());
    const queued = chunkIds.map((id) => ({ id, text: '' }));
    await storeChunkEmbeddings(
      queued,
      queued.map(() => vector()),
    );
    await getDb().execute(
      sql`update clarity_search_chunk_embeddings set model = 'previous-model' where chunk_id = ${chunkIds[1]}`,
    );
    await expect(documentChunkState(getDb(), url, body, chunks.length, EXTRACTOR)).resolves.toBe(
      'unembedded',
    );
    const before = await versions(getDb(), chunkIds);
    await storeChunkEmbeddings(
      queued,
      queued.map(() => vector(5)),
    );
    const after = await versions(getDb(), chunkIds);
    expect(after.filter((row, index) => row.embedding !== before[index].embedding)).toEqual([
      expect.objectContaining({ chunkId: chunkIds[1] }),
    ]);
    await expect(documentChunkState(getDb(), url, body, chunks.length, EXTRACTOR)).resolves.toBe(
      'current',
    );
  });

  it('skips a chunk deleted meanwhile', async () => {
    const { documentId, chunkIds } = await indexDocument(getDb());
    await getDb().delete(searchChunks).where(eq(searchChunks.id, chunkIds[0]));
    await storeChunkEmbeddings(
      chunkIds.map((id) => ({ id, text: '' })),
      chunkIds.map(() => vector()),
    );
    expect(await rowsOf(getDb(), chunkIds)).toEqual({
      backlog: 0,
      embeddings: chunkIds.length - 1,
      unembedded: 0,
      vectors: chunkIds.length - 1,
    });
    await getDb().delete(searchDocuments).where(eq(searchDocuments.id, documentId));
  });

  it('skips, without waiting, a chunk a concurrent re-chunk is deleting', async () => {
    const { chunkIds } = await indexDocument(getDb());
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let deleting: () => void = () => {};
    const isDeleting = new Promise<void>((resolve) => {
      deleting = resolve;
    });
    // The re-chunk deletes the first chunk and has not committed.
    const holder = other
      .begin(async (session) => {
        await session`delete from clarity_search_chunks where id = ${chunkIds[0]}`;
        deleting();
        await released;
        throw new Error('rolled back');
      })
      .catch(() => undefined);
    await isDeleting;
    try {
      const stored = storeChunkEmbeddings(
        chunkIds.map((id) => ({ id, text: '' })),
        chunkIds.map(() => vector()),
      ).then(() => 'stored' as const);
      const waited = new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 3_000));
      await expect(Promise.race([stored, waited])).resolves.toBe('stored');
    } finally {
      release();
      await holder;
    }
    // The re-chunk rolled back: the skipped chunk is still owed, the rest embedded.
    expect(await rowsOf(getDb(), chunkIds)).toEqual({
      backlog: 1,
      embeddings: chunkIds.length - 1,
      unembedded: 0,
      vectors: chunkIds.length - 1,
    });
  });

  it('fills a NULL-code row the previous image left, and takes it off the backlog', async () => {
    await rolledBack(async (tx) => {
      // The schema before migrations 0065–0067, and a chunk as the previous
      // image stored it once 0063 had copied it into the backlog.
      await tx.execute(sql`alter table clarity_search_chunk_embeddings
        alter column code drop not null, alter column model drop not null`);
      const { url, documentId, chunkIds } = await indexDocument(tx);
      await tx.execute(sql`insert into clarity_search_chunk_embeddings (chunk_id, document_id)
        values (${chunkIds[0]}, ${documentId})`);
      expect(await rowsOf(tx, chunkIds)).toMatchObject({ backlog: chunkIds.length, unembedded: 1 });
      await expect(documentChunkState(tx, url, body, chunks.length, EXTRACTOR)).resolves.toBe(
        'unembedded',
      );

      await storeChunkEmbeddings(
        chunkIds.map((id) => ({ id, text: '' })),
        chunkIds.map(() => vector()),
        tx,
      );
      expect(await rowsOf(tx, chunkIds)).toEqual({
        backlog: 0,
        embeddings: chunkIds.length,
        unembedded: 0,
        vectors: chunkIds.length,
      });
      await expect(documentChunkState(tx, url, body, chunks.length, EXTRACTOR)).resolves.toBe(
        'current',
      );
    });
  });

  it("queues a document's chunks that lack a current embedding, and only those", async () => {
    const { chunkIds } = await indexDocument(
      getDb(),
      chunks.map((_, index) => (index === 0 ? undefined : vector())),
    );
    await getDb().execute(
      sql`update clarity_search_chunk_embeddings set model = 'previous-model' where chunk_id = ${chunkIds[2]}`,
    );
    const [{ documentId }] = await getDb()
      .select({ documentId: searchChunks.documentId })
      .from(searchChunks)
      .where(eq(searchChunks.id, chunkIds[0]));
    vi.mocked(createEmbeddings).mockImplementation(async (texts: readonly string[]) =>
      texts.map(() => vector()),
    );
    await flushChunkEmbeddingsForTests();
    vi.mocked(createEmbeddings).mockClear();
    await queueChunkEmbeddings(documentId);
    await flushChunkEmbeddingsForTests();
    expect(vi.mocked(createEmbeddings).mock.calls.flatMap(([texts]) => texts)).toEqual([
      chunks[0].text,
      chunks[2].text,
    ]);
    expect(await rowsOf(getDb(), chunkIds)).toMatchObject({
      backlog: 0,
      embeddings: chunkIds.length,
    });
  });

  it('sweeps the backlog, and a swept chunk leaves it', async () => {
    const { url, chunkIds } = await indexDocument(getDb());
    vi.mocked(createEmbeddings).mockImplementation(async (texts: readonly string[]) =>
      texts.map(() => vector()),
    );
    await flushChunkEmbeddingsForTests();
    for (let sweeps = 0; sweeps < 20; sweeps += 1) {
      await queueEmbeddingBacklog();
      await flushChunkEmbeddingsForTests();
      if ((await rowsOf(getDb(), chunkIds)).backlog === 0) break;
    }
    expect(await rowsOf(getDb(), chunkIds)).toEqual({
      backlog: 0,
      embeddings: chunkIds.length,
      unembedded: 0,
      vectors: chunkIds.length,
    });
    await expect(documentChunkState(getDb(), url, body, chunks.length, EXTRACTOR)).resolves.toBe(
      'current',
    );
  });

  it('keeps no index over NULL codes, and no NULL code', async () => {
    const [table] = await getDb().execute<{
      nullable: number;
      partial: number;
      checks: number;
    }>(sql`
      select
        (select count(*) from pg_attribute where attrelid = 'clarity_search_chunk_embeddings'::regclass
          and attname in ('code', 'model') and not attnotnull)::int as nullable,
        (select count(*) from pg_index where indrelid = 'clarity_search_chunk_embeddings'::regclass
          and indpred is not null)::int as partial,
        (select count(*) from pg_constraint where conrelid = 'clarity_search_chunk_embeddings'::regclass
          and contype = 'c')::int as checks`);
    expect(table).toEqual({ nullable: 0, partial: 0, checks: 0 });
  });
});
