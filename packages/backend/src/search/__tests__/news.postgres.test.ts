import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { newsStories, newsStoryArticles, searchDocuments } from '../../db/schema/index.js';
import { listNewsStories, newsLanguages, newsLimit } from '../news.js';
import { publicImageUrl } from '../image-cache.js';

describe('newsLimit', () => {
  it('defaults what it cannot read and clamps what it can', () => {
    expect(newsLimit(undefined)).toBe(20);
    expect(newsLimit('abc')).toBe(20);
    expect(newsLimit('0')).toBe(20);
    expect(newsLimit('5')).toBe(5);
    expect(newsLimit('5000')).toBe(100);
  });
});

describe('newsLanguages', () => {
  it('compares primary subtags and ignores anything that is not one', () => {
    expect(newsLanguages('es-ES,en,EN-us,<script>')).toEqual(['es', 'en']);
    expect(newsLanguages(undefined)).toEqual([]);
  });
});

/**
 * `GET /news` and `/v1/news` against real Postgres: stories when clustering
 * has produced any, and until then every indexed news article as a story of one.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const url = (path: string) => `https://news-test.example/${path}`;
const urls = [url('older'), url('newer'), url('blog-post'), url('hidden'), url('stale'), url('2020/01/15/undated-old'), url('undated'), url('german')];
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
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
    ids.older = (await insertDocument(urls[0], { title: 'Older story', language: 'en-GB', publisherName: 'Example News', publishedAt: daysAgo(3) })).id;
    // No column date, but the page's own JSON-LD states one — as for every page crawled before dates were extracted.
    ids.newer = (await insertDocument(urls[1], {
      title: 'Newer story', language: 'en', description: 'What happened', imageUrl: 'https://news-test.example/i.jpg',
      structuredData: [{ '@type': 'NewsArticle', datePublished: daysAgo(1).toISOString(), publisher: { '@type': 'Organization', name: 'Stated Publisher' } }],
    })).id;
    ids.blog = (await insertDocument(urls[2], { title: 'Not news', language: 'en', documentType: 'article', publishedAt: daysAgo(1) })).id;
    ids.hidden = (await insertDocument(urls[3], { title: 'Noindex', language: 'en', noindex: true, publishedAt: daysAgo(1) })).id;
    ids.stale = (await insertDocument(urls[4], { title: 'Stale story', language: 'en', publishedAt: daysAgo(90) })).id;
    ids.oldByUrl = (await insertDocument(urls[5], { title: 'Old by its URL', language: 'en' })).id;
    ids.undated = (await insertDocument(urls[6], { title: 'Undated story', language: 'en' })).id;
    ids.german = (await insertDocument(urls[7], { title: 'Deutsche Nachricht', language: 'de-DE', publishedAt: daysAgo(2) })).id;
  });

  afterAll(async () => {
    await getDb().delete(newsStories).where(inArray(newsStories.id, [storyId]));
    await getDb().delete(searchDocuments).where(inArray(searchDocuments.canonicalUrl, urls));
    await closePostgres();
  });

  const ours = (stories: Awaited<ReturnType<typeof listNewsStories>>) =>
    stories.filter((story) => story.articles.some((article) => urls.includes(article.canonicalUrl)));

  it('serves recent news articles as stories of one: dated newest first, undated last, stale ones never', async () => {
    const stories = ours(await listNewsStories({ limit: 100 }));
    expect(stories.map((story) => story.title)).toEqual(['Newer story', 'Deutsche Nachricht', 'Older story', 'Undated story']);
    expect(stories[0]).toMatchObject({
      id: `document:${ids.newer}`,
      summary: 'What happened',
      sourceCount: 1,
      // Clarity's copy of the image, never the site's own URL.
      articles: [{ id: ids.newer, canonicalUrl: urls[1], imageUrl: publicImageUrl('documents', ids.newer, 'https://news-test.example/i.jpg'), publisher: 'Stated Publisher' }],
    });
    expect(stories[0].articles[0].imageUrl).toMatch(/^https:\/\/api\.clarity\.surf\/images\/documents\//);
    expect(JSON.stringify(stories)).not.toContain('news-test.example/i.jpg');
    expect(stories[0].articles[0].publishedAt).toBeDefined();
    expect(stories[0].lastPublishedAt).toBeInstanceOf(Date);
    expect(stories[2].articles[0].publisher).toBe('Example News');
    expect(stories[3]).toMatchObject({ firstPublishedAt: null, lastPublishedAt: null });
    expect(stories[3].articles[0].publishedAt).toBeUndefined();
    expect(stories[0].articles[0].content).toBeUndefined();
  });

  it('filters by the reader\'s languages, whatever the region', async () => {
    const titles = ours(await listNewsStories({ limit: 100, languages: 'de' })).map((story) => story.title);
    expect(titles).toEqual(['Deutsche Nachricht']);
    const english = ours(await listNewsStories({ limit: 100, languages: 'en' })).map((story) => story.title);
    expect(english).toEqual(['Newer story', 'Older story', 'Undated story']);
  });

  it('serves clustered stories with their articles once any exist', async () => {
    await getDb().insert(newsStories).values({
      id: storyId,
      title: 'One event, two outlets',
      language: 'en',
      firstPublishedAt: daysAgo(3),
      lastPublishedAt: new Date('2099-01-01T00:00:00Z'),
      sourceCount: 2,
    });
    await getDb().insert(newsStoryArticles).values([
      { storyId, documentId: ids.older, similarity: 0.9 },
      { storyId, documentId: ids.newer, similarity: 0.8 },
    ]);
    const [story] = await listNewsStories({ limit: 1 });
    expect(story).toMatchObject({ id: storyId, title: 'One event, two outlets', sourceCount: 2 });
    expect(story.articles.map((article) => article.id).sort()).toEqual([ids.newer, ids.older].sort());
  });
});
