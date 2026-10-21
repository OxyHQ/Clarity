import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../../db/index.js';
import { searchChunks, searchChunkTsvector, searchDocuments } from '../../../db/schema/index.js';
import { replaceDocumentChunks } from '../../../search/chunking.js';
import { answeredToAny } from '../../../search/public-document.js';
import { recordDiscoveredPages } from '../../../search/web-discovery.js';
import { rankedSearch, type SearchInput } from '../../../search/document-search.js';
import { nearestChunks } from '../../../search/nearest-chunks.js';
import { fetchedDocuments } from '../search-platform.js';

/**
 * `POST /v1/search`'s ranking against real Postgres. The SQL scores a document
 * by its chunks AND its title and description, so the grouping is something
 * only the database can check: grouped by the chunk's foreign key, every query
 * failed with "column title must appear in the GROUP BY clause".
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const embedding = Array.from({ length: 1024 }, (_, index) => ((index % 5) + 1) / 10);
const urls = ['https://phones.example/pixel-10-pro-review', 'https://garden.example/tomatoes'];
const discoveredUrl = 'https://phones.example/pixel-11-pro-hands-on';
const redirectedUrl = 'https://phones.example/old-review';
const documentIds: string[] = [];

const input = (query: string, mode: SearchInput['mode']): SearchInput => ({
  query,
  mode,
  limit: 20,
});

suite('ranked search on Postgres', () => {
  beforeAll(async () => {
    connectPostgres(databaseUrl);
    const database = getDb();
    await database
      .delete(searchDocuments)
      .where(inArray(searchDocuments.canonicalUrl, [...urls, discoveredUrl]));
    const pages = [
      {
        url: urls[0],
        title: 'Pixel 10 Pro review',
        description: 'The Pixel 10 Pro camera and battery, tested.',
      },
      {
        url: urls[1],
        title: 'Growing tomatoes',
        description: 'Soil, water and sun for a summer harvest.',
      },
    ];
    for (const page of pages) {
      const [document] = await database
        .insert(searchDocuments)
        .values({
          id: crypto.randomUUID(),
          requestedUrl: page.url,
          canonicalUrl: page.url,
          status: 'indexed',
          documentType: 'article',
          title: page.title,
          description: page.description,
          mainContent: page.description,
          indexedAt: new Date(),
        })
        .returning();
      documentIds.push(document.id);
      await replaceDocumentChunks(
        database,
        document.id,
        [
          { start: 0, end: page.description.length, text: page.description },
          { start: 0, end: page.title.length, text: page.title },
        ],
        [embedding, embedding],
        'test-chunker',
      );
    }
  });

  afterAll(async () => {
    await getDb()
      .delete(searchDocuments)
      .where(inArray(searchDocuments.canonicalUrl, [...urls, discoveredUrl]));
    await closePostgres();
  });

  it('ranks each matching document once, by its chunks and its title', async () => {
    const ranks = await rankedSearch(input('Pixel 10 Pro', 'lexical'), undefined, 0);
    expect(ranks.map((rank) => rank.documentId)).toEqual([documentIds[0]]);
  });

  it('runs the semantic and hybrid rankings, one row per document', async () => {
    const semantic = await rankedSearch(input('phone camera', 'semantic'), embedding, 0);
    expect(new Set(semantic.map((rank) => rank.documentId))).toEqual(new Set(documentIds));
    expect(semantic).toHaveLength(2);

    const hybrid = await rankedSearch(input('Pixel 10 Pro', 'hybrid'), embedding, 0);
    expect(hybrid[0]?.documentId).toBe(documentIds[0]);
    expect(hybrid).toHaveLength(2);
  });

  it("reads the semantic candidates from the codes' HNSW index, not by scanning every chunk", async () => {
    // The candidates' query, as `nearestChunks` sends it: ordered by the
    // Hamming distance between binary codes and limited, the shape the index
    // serves (docs/search-storage.md, "Vectors").
    const vector = JSON.stringify(embedding);
    const plan = await getDb().transaction(async (tx) => {
      await tx.execute(sql.raw('set local enable_seqscan = off'));
      return tx.execute<{ 'QUERY PLAN': string }>(sql`
        explain select chunk_id, document_id from clarity_search_chunk_embeddings
        order by code <~> binary_quantize(${vector}::halfvec(1024))::bit(1024) limit 3200`);
    });
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(
      'clarity_search_chunk_embeddings_code_hnsw_idx',
    );
  });

  it('reorders the candidates exactly, reading their vectors with one bitmap scan', async () => {
    const chunks = await getDb()
      .select({ id: searchChunks.id })
      .from(searchChunks)
      .where(inArray(searchChunks.documentId, documentIds));
    const nearest = await getDb().transaction(async (tx) => {
      await tx.execute(sql.raw('set local enable_seqscan = off'));
      const plan = await tx.execute<{ 'QUERY PLAN': string }>(sql`
        explain select chunk_id from clarity_search_chunk_vectors
        where chunk_id = any(${sql.param(chunks.map((chunk) => chunk.id))}::text[])`);
      await tx.execute(sql.raw('set local enable_indexscan = off'));
      const bitmap = await tx.execute<{ 'QUERY PLAN': string }>(sql`
        explain select chunk_id from clarity_search_chunk_vectors
        where chunk_id = any(${sql.param(chunks.map((chunk) => chunk.id))}::text[])`);
      await tx.execute(sql.raw('set local enable_indexscan = on'));
      return { plan, bitmap, found: await nearestChunks(tx, embedding, 10) };
    });
    expect(nearest.bitmap.map((row) => row['QUERY PLAN']).join('\n')).toContain(
      'Bitmap Heap Scan on clarity_search_chunk_vectors',
    );
    expect(nearest.plan.length).toBeGreaterThan(0);
    // Every embedded chunk of the two documents, nearest first, at its exact distance.
    expect(nearest.found.documentIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(nearest.found.documentIds)).toEqual(new Set(documentIds));
    expect(nearest.found.distances).toEqual([...nearest.found.distances].sort((a, b) => a - b));
    expect(nearest.found.distances[0]).toBeCloseTo(0, 3);
  });

  it('stores a chunk without its vector, and the vector at half precision beside it (docs/search-storage.md)', async () => {
    const columns = await getDb().execute<{
      table: string;
      name: string;
      type: string;
      storage: string;
    }>(sql`
      select attrelid::regclass::text as table, attname as name,
        format_type(atttypid, atttypmod) as type, attstorage as storage
      from pg_attribute
      where attrelid in ('clarity_search_chunks'::regclass, 'clarity_search_chunk_embeddings'::regclass,
        'clarity_search_chunk_vectors'::regclass)
        and attnum > 0 and not attisdropped`);
    const of = (table: string) =>
      Object.fromEntries(
        columns.filter((column) => column.table === table).map((column) => [column.name, column]),
      );
    expect(of('clarity_search_chunks')).not.toHaveProperty('embedding');
    expect(of('clarity_search_chunks')).not.toHaveProperty('search_vector');
    expect(of('clarity_search_chunk_embeddings').code?.type).toBe('bit(1024)');
    expect(of('clarity_search_chunk_vectors').embedding).toMatchObject({
      type: 'halfvec(1024)',
      storage: 'p',
    });
  });

  it('matches lexical candidates through the full-text expression index', async () => {
    // The chunks store no full-text vector (migration 0040): the lexical arm
    // matches on `searchChunkTsvector`, the expression the index holds.
    const plan = await getDb().transaction(async (tx) => {
      await tx.execute(sql.raw('set local enable_seqscan = off'));
      return tx.execute<{ 'QUERY PLAN': string }>(sql`
        explain select ${searchChunks.documentId} from ${searchChunks}
        where ${searchChunkTsvector} @@ websearch_to_tsquery('simple', 'pixel')`);
    });
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(
      'clarity_search_chunks_text_fts_idx',
    );
  });

  it('applies a document filter to the semantic ranking', async () => {
    const semantic = await rankedSearch(
      { ...input('phone camera', 'semantic'), domains: ['phones.example'] },
      embedding,
      0,
    );
    expect(semantic.map((rank) => rank.documentId)).toEqual([documentIds[0]]);
  });

  it('records web discoveries as `discovered`, never ranks them, and never overwrites an indexed page', async () => {
    const recorded = await recordDiscoveredPages(getDb(), [
      {
        canonicalUrl: discoveredUrl,
        title: 'Pixel 11 Pro hands-on',
        description: 'First impressions of the Pixel 11 Pro.',
      },
      {
        canonicalUrl: urls[0],
        title: 'A search engine title',
        description: 'A search engine snippet.',
      },
    ]);

    expect(recorded.map((row) => [row.canonicalUrl, row.status])).toEqual([
      [discoveredUrl, 'discovered'],
      [urls[0], 'indexed'],
    ]);
    expect(recorded[1]).toMatchObject({ id: documentIds[0], title: 'Pixel 10 Pro review' });

    // Again, as a second search would: the same row, not a second one.
    const [again] = await recordDiscoveredPages(getDb(), [
      { canonicalUrl: discoveredUrl, title: 'Another title' },
    ]);
    expect(again).toMatchObject({ id: recorded[0].id, title: 'Pixel 11 Pro hands-on' });

    const ranks = await rankedSearch(input('Pixel 11 Pro', 'lexical'), undefined, 0);
    expect(ranks.map((rank) => rank.documentId)).not.toContain(recorded[0].id);
  });

  it('finds a fetched page by the URL asked for, even when it was stored under another', async () => {
    // A crawl stores the page under its canonical URL; a redirect made that
    // differ from the one requested.
    await getDb()
      .update(searchDocuments)
      .set({ requestedUrl: redirectedUrl, finalUrl: urls[0] })
      .where(inArray(searchDocuments.id, [documentIds[0]]));

    const found = await fetchedDocuments([
      redirectedUrl,
      urls[1],
      discoveredUrl,
      'https://nowhere.example/',
    ]);

    expect(found.get(redirectedUrl)?.id).toBe(documentIds[0]);
    expect(found.get(urls[1])?.id).toBe(documentIds[1]);
    // Known from a web search, never fetched: not a document to read yet.
    expect(found.has(discoveredUrl)).toBe(false);
    expect(found.has('https://nowhere.example/')).toBe(false);
  });

  it('looks a document up by any of its URLs through indexes alone', async () => {
    // Every resolve and every resolve page the worker claims asks this. With
    // one URL column unindexed the OR was a scan of the whole table, about
    // half of the shared production instance (0026). Seq scans are priced out
    // so the plan shows whether an index CAN serve every branch, whatever the
    // size of this test table.
    const plan = await getDb().transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const explained = await tx.execute<{ 'QUERY PLAN': string }>(
        sql`explain ${tx
          .select({ id: searchDocuments.id })
          .from(searchDocuments)
          .where(answeredToAny([redirectedUrl, urls[1]]))}`,
      );
      return explained.map((row) => row['QUERY PLAN']).join('\n');
    });
    expect(plan).not.toContain('Seq Scan');
    for (const index of [
      'clarity_search_documents_canonical_unique',
      'clarity_search_documents_requested_url_idx',
      'clarity_search_documents_final_url_idx',
    ])
      expect(plan).toContain(index);
  });
});
