import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { searchDocuments } from '../../db/schema/index.js';
import {
  chunksNeedReplacing,
  chunkText,
  documentChunkState,
  replaceDocumentChunks,
} from '../chunking.js';

/**
 * `documentChunkState` against real Postgres. The check decides whether a feed
 * poll or a recrawl re-embeds a document and rewrites its chunks, so a wrong
 * `stale` costs an embedding call and a chunk rewrite on every poll, and a
 * wrong `current` serves stale chunks.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const EXTRACTOR = 'chunks-current-test-v1';
const current = 'https://chunks-current.example/current';
const neighbour = 'https://chunks-current.example/neighbour';
const lexical = 'https://chunks-current.example/lexical';
const urls = [current, neighbour, lexical];
const body = 'A listing body long enough to span chunks. '.repeat(100);
const chunks = chunkText(body);
const embedding = () => Array.from({ length: 1024 }, (_, i) => (i % 7) / 7);

async function indexDocument(canonicalUrl: string, embedded: boolean) {
  const [document] = await getDb()
    .insert(searchDocuments)
    .values({
      id: crypto.randomUUID(),
      requestedUrl: canonicalUrl,
      canonicalUrl,
      status: 'indexed',
      documentType: 'job',
      mainContent: body,
      indexedAt: new Date(),
    })
    .returning();
  await replaceDocumentChunks(
    getDb(),
    document.id,
    chunks,
    embedded ? chunks.map(embedding) : undefined,
    EXTRACTOR,
  );
}

suite('documentChunkState on Postgres', () => {
  beforeAll(async () => {
    connectPostgres(databaseUrl);
    await getDb().delete(searchDocuments).where(inArray(searchDocuments.canonicalUrl, urls));
    await indexDocument(current, true);
    // Another fully embedded document, so a count that is not scoped to the
    // document under test shows up as a wrong total.
    await indexDocument(neighbour, true);
    await indexDocument(lexical, false);
  });

  afterAll(async () => {
    await getDb().delete(searchDocuments).where(inArray(searchDocuments.canonicalUrl, urls));
    await closePostgres();
  });

  it('is current when the text, the extractor and every chunk embedding match', async () => {
    expect(chunks.length).toBeGreaterThan(1);
    await expect(
      documentChunkState(getDb(), current, body, chunks.length, EXTRACTOR),
    ).resolves.toBe('current');
  });

  it('is stale when the text changed', async () => {
    await expect(
      documentChunkState(getDb(), current, `${body} edited`, chunks.length, EXTRACTOR),
    ).resolves.toBe('stale');
  });

  it('is stale when the chunk count differs', async () => {
    await expect(
      documentChunkState(getDb(), current, body, chunks.length + 1, EXTRACTOR),
    ).resolves.toBe('stale');
  });

  it('is stale when the chunks came from another extractor version', async () => {
    await expect(
      documentChunkState(getDb(), current, body, chunks.length, `${EXTRACTOR}-next`),
    ).resolves.toBe('stale');
  });

  it('is unembedded when the same chunks were stored without embeddings', async () => {
    await expect(
      documentChunkState(getDb(), lexical, body, chunks.length, EXTRACTOR),
    ).resolves.toBe('unembedded');
  });

  it('rewrites chunks only when that stores something new', () => {
    expect(chunksNeedReplacing('stale', false)).toBe(true);
    expect(chunksNeedReplacing('stale', true)).toBe(true);
    // The same unembedded chunks again: nothing would change.
    expect(chunksNeedReplacing('unembedded', false)).toBe(false);
    expect(chunksNeedReplacing('unembedded', true)).toBe(true);
    expect(chunksNeedReplacing('current', false)).toBe(false);
  });

  it('is stale when the document is not indexed', async () => {
    await expect(
      documentChunkState(
        getDb(),
        'https://chunks-current.example/absent',
        body,
        chunks.length,
        EXTRACTOR,
      ),
    ).resolves.toBe('stale');
  });
});
