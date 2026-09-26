import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { getDb } from '../db/index.js';
import { newsStories, newsStoryArticles, searchDocuments } from '../db/schema/index.js';
import { iconHostsOf, publicDocument, type DocumentRow } from './public-document.js';

export const NEWS_DEFAULT_LIMIT = 20;
export const NEWS_MAX_LIMIT = 100;

/** A requested page size, clamped. Anything unparseable is the default. */
export function newsLimit(requested: unknown): number {
  const value = Math.trunc(Number(requested));
  if (!Number.isFinite(value) || value < 1) return NEWS_DEFAULT_LIMIT;
  return Math.min(value, NEWS_MAX_LIMIT);
}

/**
 * The newest news stories, each with its articles as public documents.
 *
 * Stories are clusters of articles about one event. Until a clustering pass
 * fills `clarity_news_stories`, the corpus still holds every page the crawler
 * recognised as a `NewsArticle`; each of those is served as a story of one, in
 * the same shape, so a reader of this list never has to know which it got.
 */
export async function listNewsStories(requestedLimit: unknown) {
  const limit = newsLimit(requestedLimit);
  const db = getDb();
  const stories = await db.select().from(newsStories)
    .orderBy(desc(newsStories.lastPublishedAt), desc(newsStories.rankingScore)).limit(limit);
  if (stories.length) {
    const articles = await db.select({ storyId: newsStoryArticles.storyId, document: searchDocuments })
      .from(newsStoryArticles).innerJoin(searchDocuments, eq(newsStoryArticles.documentId, searchDocuments.id))
      .where(inArray(newsStoryArticles.storyId, stories.map((story) => story.id)));
    const icons = await iconHostsOf(articles.map((item) => item.document));
    return stories.map((story) => ({
      ...story,
      articles: articles.filter((item) => item.storyId === story.id)
        .map((item) => ({ ...publicDocument(item.document, icons), highlights: [], score: 1 })),
    }));
  }
  const documents = await db.select().from(searchDocuments)
    .where(and(eq(searchDocuments.documentType, 'news'), eq(searchDocuments.status, 'indexed'), eq(searchDocuments.noindex, false)))
    .orderBy(sql`${searchDocuments.publishedAt} desc nulls last`, desc(searchDocuments.indexedAt)).limit(limit);
  const icons = await iconHostsOf(documents);
  return documents.flatMap((document) => (document.title ? [storyOfOne(document, icons)] : []));
}

function storyOfOne(document: DocumentRow, icons: ReadonlySet<string>) {
  const publishedAt = document.publishedAt ?? document.indexedAt ?? document.createdAt;
  return {
    id: `document:${document.id}`,
    title: document.title ?? '',
    summary: document.description ?? null,
    language: document.language ?? null,
    firstPublishedAt: publishedAt,
    lastPublishedAt: publishedAt,
    sourceCount: 1,
    publisherDiversity: 1,
    rankingScore: 0,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    articles: [{ ...publicDocument(document, icons), highlights: [], score: 1 }],
  };
}
