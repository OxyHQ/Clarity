import { and, desc, eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm';

import { getDb } from '../db/index.js';
import { newsStories, newsStoryArticles, searchDocuments } from '../db/schema/index.js';
import { dateFromUrl, metadataFromStructuredData } from './article-metadata.js';
import { iconHostsOf, publicDocument, type DocumentRow } from './public-document.js';

export const NEWS_DEFAULT_LIMIT = 20;
export const NEWS_MAX_LIMIT = 100;
/** A dated article older than this is not news any more. */
export const NEWS_MAX_AGE_DAYS = 30;
/** How many recent articles the fallback reads to choose a page from. */
const CANDIDATES = 400;

/** A requested page size, clamped. Anything unparseable is the default. */
export function newsLimit(requested: unknown): number {
  const value = Math.trunc(Number(requested));
  if (!Number.isFinite(value) || value < 1) return NEWS_DEFAULT_LIMIT;
  return Math.min(value, NEWS_MAX_LIMIT);
}

/**
 * `languages=es,en` as primary subtags. `en-US`, `en-GB` and `en` are one
 * reader's language, so only the primary subtag is compared. Empty means all.
 */
export function newsLanguages(requested: unknown): string[] {
  if (typeof requested !== 'string') return [];
  return [...new Set(requested.split(',').map((value) => value.trim().toLowerCase().split('-')[0])
    .filter((value) => /^[a-z]{2,3}$/.test(value)))].slice(0, 5);
}

function primaryLanguageIn(column: SQL | typeof searchDocuments.language, languages: string[]): SQL {
  return sql`lower(split_part(coalesce(${column}, ''), '-', 1)) in (${sql.join(languages.map((language) => sql`${language}`), sql`, `)})`;
}

export interface NewsQuery { limit?: unknown; languages?: unknown }

/**
 * The newest news stories, each with its articles as public documents.
 *
 * Stories are clusters of articles about one event. Until a clustering pass
 * fills `clarity_news_stories`, the corpus still holds every page the crawler
 * recognised as a `NewsArticle`; each of those is served as a story of one, in
 * the same shape, so a reader of this list never has to know which it got.
 */
export async function listNewsStories(query: NewsQuery = {}) {
  const limit = newsLimit(query.limit);
  const languages = newsLanguages(query.languages);
  const db = getDb();
  const stories = await db.select().from(newsStories)
    .where(languages.length ? primaryLanguageIn(sql`${newsStories.language}`, languages) : undefined)
    .orderBy(desc(newsStories.lastPublishedAt), desc(newsStories.rankingScore)).limit(limit);
  if (stories.length) {
    const articles = await db.select({ storyId: newsStoryArticles.storyId, document: searchDocuments })
      .from(newsStoryArticles).innerJoin(searchDocuments, eq(newsStoryArticles.documentId, searchDocuments.id))
      .where(inArray(newsStoryArticles.storyId, stories.map((story) => story.id)));
    const icons = await iconHostsOf(articles.map((item) => item.document));
    return stories.map((story) => ({
      ...story,
      articles: articles.filter((item) => item.storyId === story.id)
        .map((item) => ({ ...publicDocument({ ...item.document, mainContent: null }, icons), highlights: [], score: 1 })),
    }));
  }
  return singleArticleStories(limit, languages);
}

/** The document columns a news card needs — everything but the page text. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped on purpose: a card never needs the page text
const { mainContent: _mainContent, ...cardColumns } = getTableColumns(searchDocuments);

async function singleArticleStories(limit: number, languages: string[], now = Date.now()) {
  const rows = await getDb().select(cardColumns).from(searchDocuments)
    .where(and(
      eq(searchDocuments.documentType, 'news'), eq(searchDocuments.status, 'indexed'), eq(searchDocuments.noindex, false),
      ...(languages.length ? [primaryLanguageIn(searchDocuments.language, languages)] : []),
    ))
    .orderBy(sql`coalesce(${searchDocuments.publishedAt}, ${searchDocuments.indexedAt}) desc nulls last`)
    .limit(CANDIDATES);
  const oldest = now - NEWS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const seenTitles = new Set<string>();
  const articles = rows.flatMap((row) => {
    const document: DocumentRow = { ...row, mainContent: null };
    const title = document.title?.trim();
    if (!title) return [];
    const key = title.toLowerCase();
    if (seenTitles.has(key)) return [];
    const stated = metadataFromStructuredData(document.structuredData, now);
    const publishedAt = document.publishedAt ?? stated.publishedAt ?? dateFromUrl(document.canonicalUrl, now);
    if (publishedAt && publishedAt.getTime() < oldest) return [];
    seenTitles.add(key);
    return [{ document: { ...document, publishedAt: publishedAt ?? null, publisherName: document.publisherName ?? stated.publisher ?? null }, publishedAt }];
  });
  // Dated articles first, newest first; an undated one cannot claim to be new.
  articles.sort((a, b) => (b.publishedAt?.getTime() ?? -Infinity) - (a.publishedAt?.getTime() ?? -Infinity)
    || (b.document.indexedAt?.getTime() ?? 0) - (a.document.indexedAt?.getTime() ?? 0));
  const page = articles.slice(0, limit);
  const icons = await iconHostsOf(page.map((item) => item.document));
  return page.map(({ document, publishedAt }) => storyOfOne(document, publishedAt, icons));
}

function storyOfOne(document: DocumentRow, publishedAt: Date | undefined, icons: ReadonlySet<string>) {
  const shownAt = publishedAt ?? document.indexedAt ?? document.createdAt;
  return {
    id: `document:${document.id}`,
    title: document.title ?? '',
    summary: document.description ?? null,
    language: document.language ?? null,
    firstPublishedAt: shownAt,
    lastPublishedAt: shownAt,
    /** The article states no publication date; `lastPublishedAt` is when Clarity indexed it. */
    ...(publishedAt ? {} : { undated: true }),
    sourceCount: 1,
    publisherDiversity: 1,
    rankingScore: 0,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    articles: [{ ...publicDocument(document, icons), highlights: [], score: 1 }],
  };
}
