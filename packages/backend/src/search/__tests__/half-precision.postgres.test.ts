import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { searchChunks, searchDocuments } from '../../db/schema/index.js';
import { replaceDocumentChunks, storeChunkEmbeddings } from '../chunking.js';
import { halfVectorText } from '../half-precision.js';

/**
 * The compact text must store exactly what Kaana's full float text stored:
 * Postgres parses both into the column type and compares the halves.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

function generator(seed: number) {
  let state = seed;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647;
  };
}

suite('half-precision vector text on Postgres', () => {
  beforeAll(() => {
    connectPostgres(databaseUrl);
  });
  afterAll(async () => {
    await closePostgres();
  });

  it('parses to the same halves as the full float text, edge values included', async () => {
    const random = generator(11);
    const edges = [
      0,
      -0,
      1,
      -1,
      2 ** -14,
      2 ** -15,
      2 ** -24,
      3 * 2 ** -25,
      0.999999,
      1.000001,
      65504,
      60000,
      0.5 + 2 ** -12,
      2 - 2 ** -12,
      1e-8,
      -7.62939453125e-6,
    ];
    const vectors = Array.from({ length: 40 }, (_, index) =>
      Array.from({ length: 1024 }, (_, element) =>
        index === 0 && element < edges.length
          ? edges[element]
          : (random() - 0.5) * (index % 3 === 0 ? 2 : index % 3 === 1 ? 0.02 : 200),
      ),
    );
    for (const vector of vectors) {
      const full = `[${vector.join(',')}]`;
      const compact = halfVectorText(vector);
      expect(compact.length).toBeLessThan(full.length);
      const [row] = await getDb().execute<{ same: boolean }>(
        sql`select (${full}::halfvec(1024) = ${compact}::halfvec(1024)) as same`,
      );
      expect(row.same).toBe(true);
    }
  });

  it('writes a vector only into a chunk still owed one', async () => {
    const url = `https://half-precision.example/${crypto.randomUUID()}`;
    const [document] = await getDb()
      .insert(searchDocuments)
      .values({ id: crypto.randomUUID(), requestedUrl: url, canonicalUrl: url, status: 'indexed' })
      .returning();
    const vector = Array.from({ length: 1024 }, (_, index) => (index % 7) / 10);
    await replaceDocumentChunks(
      getDb(),
      document.id,
      [
        { start: 0, end: 5, text: 'first' },
        { start: 5, end: 11, text: 'second' },
      ],
      [vector, undefined as unknown as number[]],
      'test-chunker',
    );
    const chunks = await getDb()
      .select({ id: searchChunks.id, position: searchChunks.position })
      .from(searchChunks)
      .where(eq(searchChunks.documentId, document.id))
      .orderBy(searchChunks.position);
    const version = async (id: string) => {
      const [row] = await getDb().execute<{ xmin: string; embedded: boolean }>(
        sql`select e.xmin::text || coalesce(v.xmin::text, '') as xmin, e.code is not null as embedded
          from clarity_search_chunk_embeddings e left join clarity_search_chunk_vectors v on v.chunk_id = e.chunk_id
          where e.chunk_id = ${id}`,
      );
      return row;
    };
    const embeddedBefore = await version(chunks[0].id);
    await storeChunkEmbeddings(
      chunks.map((chunk) => ({ id: chunk.id, text: '' })),
      [vector, vector],
    );
    // Already embedded with the current model: not rewritten.
    expect(await version(chunks[0].id)).toEqual(embeddedBefore);
    expect((await version(chunks[1].id)).embedded).toBe(true);
    await getDb().delete(searchDocuments).where(eq(searchDocuments.id, document.id));
  });
});
