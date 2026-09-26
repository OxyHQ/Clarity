import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { newsStories, newsStoryArticles, searchDocuments } from '../../db/schema/index.js';
import { listNewsStories, newsLimit } from '../news.js';

describe('newsLimit', () => {
  it('defaults what it cannot read and clamps what it can', () => {
    expect(newsLimit(undefined)).toBe(20);
    expect(newsLimit('abc')).toBe(20);
    expect(newsLimit('0')).toBe(20);
    expect(newsLimit('5')).toBe(5);
    expect(newsLimit('5000')).toBe(100);
  });
});

/**
 * `GET /news` and `/v1/news` against real Postgres: stories when clustering
 * has produced any, and until then every indexed news article as a story of one.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const url = (path: string) => `https://news-test.example/${path}`;
const urls = [url('older'), url('newer'), url('blog-post'), url('hidden')];
const storyId = `test-story-${crypto.randomUUID()}`;

async function insertDocument(canonicalUrl: string, values: Partial<typeof searchDocuments.$inferInsert>) {
  const [document] = await getDb().insert(searchDocuments).values({
    id: crypto.randomUUID(),
    requestedUrl: canonicalUrl,
    canonicalUrl,
    status: 'indexed',
    documentType: 'news',
    indexedAt: new Date(),
    ...values,
  }).returning();
  return document;
}

suite('news on Postgres', () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    connectPostgres(databaseUrl);
    await getDb().delete(searchDocuments).where(inArray(searchDocuments.canonicalUrl, urls));
    ids.older = (await insertDocument(urls[0], { title: 'Older story', publisherName: 'Example News', publishedAt: new Date('2026-09-01T00:00:00Z') })).id;
    ids.newer = (await insertDocument(urls[1], { title: 'Newer story', description: 'What happened', imageUrl: 'https://news-test.example/i.jpg', publishedAt: new Date('2026-09-02T00:00:00Z') })).id;
    ids.blog = (await insertDocument(urls[2], { title: 'Not news', documentType: 'article', publishedAt: new Date('2026-09-03T00:00:00Z') })).id;
    ids.hidden = (await insertDocument(urls[3], { title: 'Noindex', noindex: true, publishedAt: new Date('2026-09-03T00:00:00Z') })).id;
  });

  afterAll(async () => {
    await getDb().delete(newsStories).where(inArray(newsStories.id, [storyId]));
    await getDb().delete(searchDocuments).where(inArray(searchDocuments.canonicalUrl, urls));
    await closePostgres();
  });

  it('serves indexed news articles, newest first, as stories of one', async () => {
    const stories = (await listNewsStories(100)).filter((story) => story.articles.some((article) => urls.includes(article.canonicalUrl)));
    expect(stories.map((story) => story.title)).toEqual(['Newer story', 'Older story']);
    expect(stories[0]).toMatchObject({
      id: `document:${ids.newer}`,
      summary: 'What happened',
      sourceCount: 1,
      lastPublishedAt: new Date('2026-09-02T00:00:00Z'),
      articles: [{ id: ids.newer, canonicalUrl: urls[1], imageUrl: 'https://news-test.example/i.jpg' }],
    });
    expect(stories[1].articles[0].publisher).toBe('Example News');
  });

  it('serves clustered stories with their articles once any exist', async () => {
    await getDb().insert(newsStories).values({
      id: storyId,
      title: 'One event, two outlets',
      firstPublishedAt: new Date('2026-09-01T00:00:00Z'),
      lastPublishedAt: new Date('2099-01-01T00:00:00Z'),
      sourceCount: 2,
    });
    await getDb().insert(newsStoryArticles).values([
      { storyId, documentId: ids.older, similarity: 0.9 },
      { storyId, documentId: ids.newer, similarity: 0.8 },
    ]);
    const [story] = await listNewsStories(1);
    expect(story).toMatchObject({ id: storyId, title: 'One event, two outlets', sourceCount: 2 });
    expect(story.articles.map((article) => article.id).sort()).toEqual([ids.newer, ids.older].sort());
  });
});
