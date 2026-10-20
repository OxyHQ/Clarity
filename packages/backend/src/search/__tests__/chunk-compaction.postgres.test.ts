import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { searchChunks, searchDocuments } from '../../db/schema/index.js';
import {
  buildCompactIndexes,
  compactSearchChunks,
  copyChunkBatch,
  countChunkCopy,
  pruneCopiedOrphans,
} from '../chunk-compaction.js';
import { replaceDocumentChunks, storeChunkEmbeddings } from '../chunking.js';

/**
 * The compact copy of the search chunks (migration 0041): the trigger mirrors
 * every write, the one-shot copies what existed before, prunes what a race
 * brought back, and records the copy only when the counts agree.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const url = `https://compaction.example/${crypto.randomUUID()}`;
const vectorOf = (seed: number) =>
  Array.from({ length: 1024 }, (_, index) => (((index + seed) % 7) + 1) / 9);
let documentId = '';

type CopiedRow = {
  id: string;
  text: string;
  position: number;
  embedding: string | null;
  expected: string | null;
};

/** The copy's rows for the test document, beside the live embedding at half precision. */
async function copiedRows(): Promise<CopiedRow[]> {
  return getDb().execute<CopiedRow>(sql`
    select c.id, c.text, c.position, c.embedding::text as embedding,
      (select l.embedding::halfvec(1024)::text from clarity_search_chunks l where l.id = c.id) as expected
    from clarity_search_chunks_compact c
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
    const batch = await copyChunkBatch(getDb(), after, 500);
    if (batch.read < 500 || batch.last === null) return;
    after = batch.last;
  }
}

async function pruneEverything(): Promise<number> {
  let after: string | null = null;
  let deleted = 0;
  for (;;) {
    const window = await pruneCopiedOrphans(getDb(), after, 500);
    deleted += window.deleted;
    if (window.examined < 500 || window.last === null) return deleted;
    after = window.last;
  }
}

suite('search chunk compaction on Postgres', () => {
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
        title: 'Compaction',
        mainContent: 'first second third',
        indexedAt: new Date(),
      })
      .returning();
    documentId = document.id;
    await replaceDocumentChunks(
      getDb(),
      documentId,
      [
        { start: 0, end: 5, text: 'first' },
        { start: 6, end: 12, text: 'second' },
        { start: 13, end: 18, text: 'third' },
      ],
      [vectorOf(1), vectorOf(2), undefined as unknown as number[]],
      'test-chunker',
    );
  });

  afterAll(async () => {
    await getDb().delete(searchDocuments).where(eq(searchDocuments.canonicalUrl, url));
    await closePostgres();
  });

  it('mirrors every write into the copy, embeddings at half precision', async () => {
    const ids = await liveIds();
    let copied = await copiedRows();
    expect(copied.map((row) => row.id)).toEqual(ids);
    expect(copied.map((row) => row.text)).toEqual(['first', 'second', 'third']);
    expect(copied[0].embedding).not.toBeNull();
    expect(copied[0].embedding).toBe(copied[0].expected);
    expect(copied[2].embedding).toBeNull();

    await storeChunkEmbeddings([{ id: ids[2], text: 'third' }], [vectorOf(3)]);
    copied = await copiedRows();
    expect(copied[2].embedding).not.toBeNull();
    expect(copied[2].embedding).toBe(copied[2].expected);

    // A replacement (delete, then insert at the same positions) leaves only the new rows.
    await replaceDocumentChunks(
      getDb(),
      documentId,
      [
        { start: 0, end: 5, text: 'first' },
        { start: 6, end: 12, text: 'second' },
        { start: 13, end: 18, text: 'third' },
      ],
      [vectorOf(1), vectorOf(2), vectorOf(3)],
      'test-chunker',
    );
    copied = await copiedRows();
    expect(copied.map((row) => row.id)).toEqual(await liveIds());
    expect(copied.every((row) => row.embedding === row.expected)).toBe(true);
  });

  it('copies the rows that predate the trigger, and a newer mirrored row wins', async () => {
    const ids = await liveIds();
    // The rows as they were before 0041: in the live table only.
    await getDb().execute(
      sql`delete from clarity_search_chunks_compact where id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
    expect(await copiedRows()).toEqual([]);

    await copyEverything();
    const copied = await copiedRows();
    expect(copied.map((row) => row.id)).toEqual(ids);
    expect(copied.every((row) => row.embedding === row.expected)).toBe(true);

    // Copying again changes nothing.
    await copyEverything();
    expect(await copiedRows()).toEqual(copied);
  });

  it('prunes a copied row the live table no longer holds', async () => {
    const orphan = crypto.randomUUID();
    await getDb().execute(sql`
      insert into clarity_search_chunks_compact
        (id, document_id, position, start_offset, end_offset, text, extractor_version)
      values (${orphan}, ${documentId}, 99, 0, 1, 'gone', 'test-chunker')`);
    expect(await pruneEverything()).toBeGreaterThanOrEqual(1);
    const copied = await copiedRows();
    expect(copied.map((row) => row.id)).toEqual(await liveIds());

    const counts = await countChunkCopy(getDb());
    expect(counts.copied).toBe(counts.live);
  });

  it('builds the copy indexes and a validated foreign key, idempotently', async () => {
    await buildCompactIndexes(getDb());
    await buildCompactIndexes(getDb());
    const indexes = await getDb().execute<{ name: string; valid: boolean }>(sql`
      select c.relname as name, i.indisvalid as valid
      from pg_index i join pg_class c on c.oid = i.indexrelid
      where i.indrelid = 'clarity_search_chunks_compact'::regclass
      order by c.relname`);
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'clarity_search_chunks_compact_embedding_halfvec_hnsw_idx',
        'clarity_search_chunks_compact_text_fts_idx',
      ]),
    );
    expect(indexes.every((index) => index.valid)).toBe(true);
    const [key] = await getDb().execute<{ validated: boolean }>(sql`
      select convalidated as validated from pg_constraint
      where conname = 'clarity_search_chunks_compact_document_fk'`);
    expect(key?.validated).toBe(true);

    // The copy's chunks leave with their document.
    const other = `https://compaction.example/${crypto.randomUUID()}`;
    const [document] = await getDb()
      .insert(searchDocuments)
      .values({
        id: crypto.randomUUID(),
        requestedUrl: other,
        canonicalUrl: other,
        status: 'indexed',
        documentType: 'article',
        mainContent: 'x',
      })
      .returning();
    await replaceDocumentChunks(
      getDb(),
      document.id,
      [{ start: 0, end: 1, text: 'x' }],
      undefined,
      'test-chunker',
    );
    await getDb()
      .delete(searchDocuments)
      .where(inArray(searchDocuments.id, [document.id]));
    const [left] = await getDb().execute<{ count: string }>(
      sql`select count(*) as count from clarity_search_chunks_compact where document_id = ${document.id}`,
    );
    expect(Number(left?.count)).toBe(0);
  });

  it('records the copy once the counts agree', async () => {
    const events: string[] = [];
    const result = await compactSearchChunks(getDb(), {
      batchSize: 500,
      dutyCycle: 1,
      log: (event) => events.push(event),
    });
    expect(events).toEqual(['copied', 'pruned', 'counted', 'indexed', 'recorded']);
    const [marker] = await getDb().execute<{ rows: string }>(
      sql`select rows from clarity_search_chunk_compaction where id = 1`,
    );
    expect(Number(marker?.rows)).toBe(result.rows);
  });
});
