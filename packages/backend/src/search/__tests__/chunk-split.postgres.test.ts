import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { searchChunks, searchDocuments } from '../../db/schema/index.js';
import {
  SPLIT_TABLES,
  buildSplitIndexes,
  copySplitBatch,
  pruneSplitOrphans,
  splitCountsMatch,
  splitSearchChunks,
} from '../chunk-split.js';
import { replaceDocumentChunks, storeChunkEmbeddings } from '../chunking.js';

/**
 * The split copy of the search chunks (migration 0050): the trigger mirrors
 * every write into the chunk, code and vector tables, the one-shot copies what
 * existed before, prunes what a race brought back, and records the copy only
 * when the counts agree.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const url = `https://split.example/${crypto.randomUUID()}`;
const vectorOf = (seed: number) =>
  Array.from(
    { length: 1024 },
    (_, index) => ((((index + seed) % 7) + 1) / 9) * (index % 2 ? 1 : -1),
  );
let documentId = '';

type SplitRow = {
  id: string;
  text: string;
  position: number;
  /** The code and the vector match the live chunk's embedding exactly. */
  codeMatches: boolean | null;
  vectorMatches: boolean | null;
  coded: boolean;
  vectored: boolean;
  model: string | null;
  liveModel: string | null;
};

/** The copies' rows for the test document, beside the live chunk they mirror. */
async function splitRows(): Promise<SplitRow[]> {
  return getDb().execute<SplitRow>(sql`
    select c.id, c.text, c.position,
      e.code = binary_quantize(l.embedding)::bit(1024) as "codeMatches",
      v.embedding::text = l.embedding::text as "vectorMatches",
      e.code is not null as coded, v.chunk_id is not null as vectored,
      e.model, l.embedding_model as "liveModel"
    from clarity_search_chunks_compact c
    left join clarity_search_chunk_embeddings e on e.chunk_id = c.id
    left join clarity_search_chunk_vectors v on v.chunk_id = c.id
    left join clarity_search_chunks l on l.id = c.id
    where c.document_id = ${documentId}
    order by c.position`);
}

async function liveIds(): Promise<string[]> {
  const rows = await getDb()
    .select({ id: searchChunks.id })
    .from(searchChunks)
    .where(eq(searchChunks.documentId, documentId))
    .orderBy(searchChunks.position);
  return rows.map((row) => row.id);
}

async function copyEverything(): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const batch = await copySplitBatch(getDb(), after, 500);
    if (batch.read < 500 || batch.last === null) return;
    after = batch.last;
  }
}

async function pruneEverything(): Promise<number> {
  let deleted = 0;
  for (const copy of SPLIT_TABLES) {
    let after: string | null = null;
    for (;;) {
      const window = await pruneSplitOrphans(getDb(), copy, after, 500);
      deleted += window.deleted;
      if (window.examined < 500 || window.last === null) break;
      after = window.last;
    }
  }
  return deleted;
}

const threeChunks = [
  { start: 0, end: 5, text: 'first' },
  { start: 6, end: 12, text: 'second' },
  { start: 13, end: 18, text: 'third' },
];

suite('search chunk split on Postgres', () => {
  beforeAll(async () => {
    connectPostgres(databaseUrl);
    const [document] = await getDb()
      .insert(searchDocuments)
      .values({
        id: crypto.randomUUID(),
        requestedUrl: url,
        canonicalUrl: url,
        status: 'indexed',
        documentType: 'article',
        title: 'Split',
        indexedAt: new Date(),
      })
      .returning();
    documentId = document.id;
    await replaceDocumentChunks(
      getDb(),
      documentId,
      threeChunks,
      [vectorOf(1), vectorOf(2), undefined as unknown as number[]],
      'test-chunker',
    );
  });

  afterAll(async () => {
    await getDb().delete(searchDocuments).where(eq(searchDocuments.canonicalUrl, url));
    await closePostgres();
  });

  it('mirrors every write into the three tables', async () => {
    const ids = await liveIds();
    let rows = await splitRows();
    expect(rows.map((row) => row.id)).toEqual(ids);
    expect(rows.map((row) => row.text)).toEqual(['first', 'second', 'third']);
    expect(rows[0]).toMatchObject({
      coded: true,
      vectored: true,
      codeMatches: true,
      vectorMatches: true,
    });
    expect(rows[0].model).toBe(rows[0].liveModel);
    expect(rows[2]).toMatchObject({ coded: false, vectored: false, model: null });

    // A vector written later reaches the code and the vector rows.
    await storeChunkEmbeddings([{ id: ids[2], text: 'third' }], [vectorOf(3)]);
    rows = await splitRows();
    expect(rows[2]).toMatchObject({
      coded: true,
      vectored: true,
      codeMatches: true,
      vectorMatches: true,
    });

    // A replacement (delete, then insert at the same positions) leaves only the new rows.
    await replaceDocumentChunks(
      getDb(),
      documentId,
      threeChunks,
      [vectorOf(4), vectorOf(5), vectorOf(6)],
      'test-chunker',
    );
    rows = await splitRows();
    expect(rows.map((row) => row.id)).toEqual(await liveIds());
    expect(rows.every((row) => row.codeMatches && row.vectorMatches)).toBe(true);
    const [orphans] = await getDb().execute<{ count: string }>(sql`
      select (select count(*) from clarity_search_chunk_embeddings e
        where e.document_id = ${documentId}
          and not exists (select 1 from clarity_search_chunks l where l.id = e.chunk_id)) as count`);
    expect(Number(orphans?.count)).toBe(0);
  });

  it('copies the rows that predate the trigger, and a newer mirrored row wins', async () => {
    const ids = await liveIds();
    const before = await splitRows();
    // The rows as they were before 0050: in the live table only.
    for (const { table, key } of SPLIT_TABLES)
      await getDb().execute(
        sql`delete from ${sql.raw(table)} where ${sql.raw(key)} in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    expect(await splitRows()).toEqual([]);

    await copyEverything();
    expect(await splitRows()).toEqual(before);

    // Copying again changes nothing.
    await copyEverything();
    expect(await splitRows()).toEqual(before);
  });

  it('prunes copied rows whose chunk the live table no longer holds', async () => {
    const orphan = crypto.randomUUID();
    await getDb().execute(sql`
      insert into clarity_search_chunks_compact
        (id, document_id, position, start_offset, end_offset, text, extractor_version)
      values (${orphan}, ${documentId}, 99, 0, 1, 'gone', 'test-chunker')`);
    await getDb().execute(sql`
      insert into clarity_search_chunk_embeddings (chunk_id, document_id, code, model)
      values (${orphan}, ${documentId}, binary_quantize(${JSON.stringify(vectorOf(7))}::halfvec(1024))::bit(1024), 'test')`);
    await getDb().execute(sql`
      insert into clarity_search_chunk_vectors (chunk_id, embedding)
      values (${orphan}, ${JSON.stringify(vectorOf(7))}::halfvec(1024))`);
    expect(await pruneEverything()).toBeGreaterThanOrEqual(3);
    const rows = await splitRows();
    expect(rows.map((row) => row.id)).toEqual(await liveIds());
    for (const { table, key } of SPLIT_TABLES) {
      const [left] = await getDb().execute<{ count: string }>(
        sql`select count(*) as count from ${sql.raw(table)} where ${sql.raw(key)} = ${orphan}`,
      );
      expect(Number(left?.count)).toBe(0);
    }
  });

  it('builds the indexes and validated foreign keys, idempotently', async () => {
    await buildSplitIndexes(getDb());
    await buildSplitIndexes(getDb());
    const indexes = await getDb().execute<{ name: string; valid: boolean }>(sql`
      select c.relname as name, i.indisvalid as valid
      from pg_index i join pg_class c on c.oid = i.indexrelid
      where i.indrelid in (
        'clarity_search_chunks_compact'::regclass,
        'clarity_search_chunk_embeddings'::regclass
      )
      order by c.relname`);
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'clarity_search_chunk_embeddings_code_hnsw_idx',
        'clarity_search_chunk_embeddings_unembedded_idx',
        'clarity_search_chunks_compact_text_fts_idx',
      ]),
    );
    expect(indexes.every((index) => index.valid)).toBe(true);
    const keys = await getDb().execute<{ name: string; validated: boolean }>(sql`
      select conname as name, convalidated as validated from pg_constraint
      where conname in (
        'clarity_search_chunks_compact_document_fk',
        'clarity_search_chunk_embeddings_chunk_fk',
        'clarity_search_chunk_vectors_chunk_fk'
      )`);
    expect(keys).toHaveLength(3);
    expect(keys.every((key) => key.validated)).toBe(true);

    // Every copy leaves with its document.
    const other = `https://split.example/${crypto.randomUUID()}`;
    const [document] = await getDb()
      .insert(searchDocuments)
      .values({
        id: crypto.randomUUID(),
        requestedUrl: other,
        canonicalUrl: other,
        status: 'indexed',
        documentType: 'article',
      })
      .returning();
    await replaceDocumentChunks(
      getDb(),
      document.id,
      [{ start: 0, end: 1, text: 'x' }],
      [vectorOf(8)],
      'test-chunker',
    );
    await getDb()
      .delete(searchDocuments)
      .where(inArray(searchDocuments.id, [document.id]));
    const [left] = await getDb().execute<{ chunks: string; codes: string }>(sql`
      select (select count(*) from clarity_search_chunks_compact where document_id = ${document.id}) as chunks,
        (select count(*) from clarity_search_chunk_embeddings where document_id = ${document.id}) as codes`);
    expect(Number(left?.chunks)).toBe(0);
    expect(Number(left?.codes)).toBe(0);
  });

  it('records the copy once the counts agree', async () => {
    const events: string[] = [];
    const result = await splitSearchChunks(getDb(), {
      batchSize: 500,
      dutyCycle: 1,
      log: (event) => events.push(event),
    });
    expect(events).toEqual(['copied', 'pruned', 'counted', 'indexed', 'recorded']);
    const [marker] = await getDb().execute<{ rows: string }>(
      sql`select rows from clarity_search_chunk_split where id = 1`,
    );
    expect(Number(marker?.rows)).toBe(result.rows);
  });

  it('refuses counts that differ', () => {
    const counts = { live: 3, embedded: 2, chunks: 3, codes: 3, coded: 2, vectors: 2 };
    expect(splitCountsMatch(counts)).toBe(true);
    expect(splitCountsMatch({ ...counts, vectors: 1 })).toBe(false);
    expect(splitCountsMatch({ ...counts, coded: 3 })).toBe(false);
    expect(splitCountsMatch({ ...counts, chunks: 2 })).toBe(false);
  });
});
