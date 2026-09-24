import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../../db/index.js';
import { searchDocuments } from '../../../db/schema/index.js';
import { replaceDocumentChunks } from '../../../search/chunking.js';
import { recordDiscoveredPages } from '../../../search/web-discovery.js';
import { rankedSearch, type SearchInput } from '../search-platform.js';

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
const documentIds: string[] = [];

const input = (query: string, mode: SearchInput['mode']): SearchInput => ({ query, mode, limit: 20 });

suite('ranked search on Postgres', () => {
  beforeAll(async () => {
    connectPostgres(databaseUrl);
    const database = getDb();
    await database.delete(searchDocuments).where(inArray(searchDocuments.canonicalUrl, [...urls, discoveredUrl]));
    const pages = [
      { url: urls[0], title: 'Pixel 10 Pro review', description: 'The Pixel 10 Pro camera and battery, tested.' },
      { url: urls[1], title: 'Growing tomatoes', description: 'Soil, water and sun for a summer harvest.' },
    ];
    for (const page of pages) {
      const [document] = await database.insert(searchDocuments).values({
        id: crypto.randomUUID(),
        requestedUrl: page.url,
        canonicalUrl: page.url,
        status: 'indexed',
        documentType: 'article',
        title: page.title,
        description: page.description,
        mainContent: page.description,
        indexedAt: new Date(),
      }).returning();
      documentIds.push(document.id);
      await replaceDocumentChunks(
        database,
        document.id,
        [{ start: 0, end: page.description.length, text: page.description }, { start: 0, end: page.title.length, text: page.title }],
        [embedding, embedding],
        'test-chunker',
      );
    }
  });

  afterAll(async () => {
    await getDb().delete(searchDocuments).where(inArray(searchDocuments.canonicalUrl, [...urls, discoveredUrl]));
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

  it('records web discoveries as `discovered`, never ranks them, and never overwrites an indexed page', async () => {
    const recorded = await recordDiscoveredPages(getDb(), [
      { canonicalUrl: discoveredUrl, title: 'Pixel 11 Pro hands-on', description: 'First impressions of the Pixel 11 Pro.' },
      { canonicalUrl: urls[0], title: 'A search engine title', description: 'A search engine snippet.' },
    ]);

    expect(recorded.map((row) => [row.canonicalUrl, row.status])).toEqual([
      [discoveredUrl, 'discovered'],
      [urls[0], 'indexed'],
    ]);
    expect(recorded[1]).toMatchObject({ id: documentIds[0], title: 'Pixel 10 Pro review' });

    // Again, as a second search would: the same row, not a second one.
    const [again] = await recordDiscoveredPages(getDb(), [{ canonicalUrl: discoveredUrl, title: 'Another title' }]);
    expect(again).toMatchObject({ id: recorded[0].id, title: 'Pixel 11 Pro hands-on' });

    const ranks = await rankedSearch(input('Pixel 11 Pro', 'lexical'), undefined, 0);
    expect(ranks.map((rank) => rank.documentId)).not.toContain(recorded[0].id);
  });
});
