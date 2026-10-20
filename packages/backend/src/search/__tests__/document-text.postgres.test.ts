import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { searchDocuments } from '../../db/schema/index.js';
import { chunkText, documentChunkState, replaceDocumentChunks } from '../chunking.js';
import { compactDocumentBatch, structuredDataIsRead } from '../document-text-compaction.js';
import { mainContentToStore, withPageText } from '../page-text.js';
import { searchResultColumns } from '../public-document.js';

/**
 * A document's page text lives in its chunks (page-text.ts): the text comes
 * back exactly from them, the snippet from the first one, and the one-shot
 * clears only what they reproduce byte for byte.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const run = crypto.randomUUID();
const urlOf = (name: string) => `https://page-text.example/${run}/${name}`;
const longText = Array.from({ length: 900 }, (_, index) => `word${index}`).join(' ');
// An astral character straddling the first chunk boundary (1,600): chunkText
// cuts it in half, and Postgres stores the lone half as U+FFFD.
const splitText = `${'a'.repeat(1_599)}😀${'b'.repeat(2_500)}`;
const ids: Record<string, string> = {};

async function insertDocument(
  name: string,
  values: { mainContent: string | null; structuredData?: unknown[]; documentType?: string },
): Promise<string> {
  const [document] = await getDb()
    .insert(searchDocuments)
    .values({
      id: crypto.randomUUID(),
      requestedUrl: urlOf(name),
      canonicalUrl: urlOf(name),
      status: 'indexed',
      documentType: values.documentType ?? 'page',
      title: name,
      mainContent: values.mainContent,
      structuredData: values.structuredData ?? [],
      indexedAt: new Date(),
    })
    .returning();
  ids[name] = document.id;
  return document.id;
}

async function stored(name: string) {
  const [row] = await getDb()
    .select({
      mainContent: searchDocuments.mainContent,
      structuredData: searchDocuments.structuredData,
    })
    .from(searchDocuments)
    .where(eq(searchDocuments.id, ids[name]));
  return row;
}

async function compactAll(): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const batch = await compactDocumentBatch(getDb(), after, 200);
    if (batch.read < 200 || batch.last === null) return;
    after = batch.last;
  }
}

suite('page text in chunks on Postgres', () => {
  beforeAll(async () => {
    connectPostgres(databaseUrl);
    // Legacy rows: the text stored AND chunked, as before this change.
    for (const [name, text] of [
      ['long', longText],
      ['split', splitText],
    ] as const) {
      const id = await insertDocument(name, { mainContent: text });
      await replaceDocumentChunks(getDb(), id, chunkText(text), undefined, 'test-chunker');
    }
    // A noindex page: text, no chunks.
    await insertDocument('unchunked', { mainContent: 'kept as it is' });
    await insertDocument('article-ld', {
      mainContent: null,
      structuredData: [{ '@type': 'Article', datePublished: '2026-01-01' }],
    });
    await insertDocument('job-ld', {
      mainContent: null,
      documentType: 'job',
      structuredData: [{ '@type': 'JobPosting', title: 'Engineer' }],
    });
    await insertDocument('news-ld', {
      mainContent: null,
      documentType: 'news',
      structuredData: [{ '@type': 'NewsArticle', datePublished: '2026-01-01' }],
    });
  });

  afterAll(async () => {
    await getDb()
      .delete(searchDocuments)
      .where(inArray(searchDocuments.id, Object.values(ids)));
    await closePostgres();
  });

  it('stores no text a write can get back from its chunks', () => {
    expect(mainContentToStore(longText, chunkText(longText))).toBeNull();
    expect(mainContentToStore(splitText, chunkText(splitText))).toBe(splitText);
    expect(mainContentToStore('no chunks', [])).toBe('no chunks');
    expect(mainContentToStore(undefined, [])).toBeNull();
  });

  it('clears only the text the chunks reproduce exactly, and JSON-LD nobody reads', async () => {
    expect(structuredDataIsRead('job', [{ '@type': 'JobPosting' }])).toBe(true);
    expect(structuredDataIsRead('news', [{ '@type': 'NewsArticle' }])).toBe(true);
    expect(structuredDataIsRead('page', [{ '@type': 'Article' }])).toBe(false);

    await compactAll();
    expect((await stored('long'))?.mainContent).toBeNull();
    expect((await stored('split'))?.mainContent).toBe(splitText);
    expect((await stored('unchunked'))?.mainContent).toBe('kept as it is');
    expect((await stored('article-ld'))?.structuredData).toEqual([]);
    expect((await stored('job-ld'))?.structuredData).toEqual([
      { '@type': 'JobPosting', title: 'Engineer' },
    ]);
    expect((await stored('news-ld'))?.structuredData).toEqual([
      { '@type': 'NewsArticle', datePublished: '2026-01-01' },
    ]);

    // Running again changes nothing.
    await compactAll();
    expect((await stored('split'))?.mainContent).toBe(splitText);
  });

  it('gives the cleared text back exactly, and the snippet from the first chunk', async () => {
    const rows = await getDb()
      .select()
      .from(searchDocuments)
      .where(inArray(searchDocuments.id, [ids.long, ids.split, ids.unchunked]));
    const filled = await withPageText(getDb(), rows);
    const textOf = (id: string) => filled.find((row) => row.id === id)?.mainContent;
    expect(textOf(ids.long)).toBe(longText);
    expect(textOf(ids.split)).toBe(splitText);
    expect(textOf(ids.unchunked)).toBe('kept as it is');

    const [result] = await getDb()
      .select(searchResultColumns)
      .from(searchDocuments)
      .where(eq(searchDocuments.id, ids.long));
    expect(result.mainContent).toBe(longText.slice(0, 1_000));
  });

  it('reads a document whose chunks hold its text as current', async () => {
    expect(
      await documentChunkState(
        getDb(),
        urlOf('long'),
        longText,
        chunkText(longText).length,
        'test-chunker',
      ),
    ).toBe('unembedded');
    expect(
      await documentChunkState(
        getDb(),
        urlOf('long'),
        `${longText} changed`,
        chunkText(`${longText} changed`).length,
        'test-chunker',
      ),
    ).toBe('stale');
    // A row still holding its text is compared with it directly.
    const [row] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(searchDocuments)
      .where(eq(searchDocuments.id, ids.split));
    expect(row.count).toBe(1);
    expect(
      await documentChunkState(
        getDb(),
        urlOf('split'),
        splitText,
        chunkText(splitText).length,
        'test-chunker',
      ),
    ).toBe('unembedded');
  });
});
