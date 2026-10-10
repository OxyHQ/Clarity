import { and, desc, eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm';

import { getDb } from '../db/index.js';
import { newsStories, newsStoryArticles, searchDocuments } from '../db/schema/index.js';
import { dateFromUrl, metadataFromStructuredData } from './article-metadata.js';
import { iconHostsOf, publicDocument, type DocumentCardRow } from './public-document.js';

export const NEWS_DEFAULT_LIMIT = 20;
export const NEWS_MAX_LIMIT = 100;
/** A dated article older than this is not news any more. */
export const NEWS_MAX_AGE_DAYS = 30;
/** How many recent articles the fallback reads to choose a page from. */
const CANDIDATES = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  return [...new Set(requested.split(',').map((value) => value.trim().toLowerCase().split(/[-_]/)[0])
    .filter((value) => /^[a-z]{2,3}$/.test(value)))].slice(0, 5);
}

function primaryLanguageIn(column: SQL, languages: string[]): SQL {
  return sql`lower(split_part(replace(coalesce(${column}, ''), '_', '-'), '-', 1)) in (${sql.join(languages.map((language) => sql`${language}`), sql`, `)})`;
}

/** `languages` (or the SDK's single `language`) as sent on a query string. */
export interface NewsQuery { limit?: unknown; languages?: unknown; language?: unknown }

/** The document columns a news card needs — everything but the page text. */
// `_mainContent` is dropped on purpose: a card never needs the page text.
const { mainContent: _mainContent, ...cardColumns } = getTableColumns(searchDocuments);

/**
 * The newest news stories, each with its articles as public documents.
 *
 * Stories are clusters of articles about one event. Until a clustering pass
 * fills `clarity_news_stories`, the corpus still holds every page the crawler
 * recognised as a `NewsArticle`; each of those is served as a story of one, in
 * the same shape, so a reader of this list never has to know which it got.
 * A story whose article states no publication date has `null` dates: the time
 * Clarity crawled a page is never presented as the time the news broke.
 */
export async function listNewsStories(query: NewsQuery = {}) {
  const limit = newsLimit(query.limit);
  const languages = newsLanguages(query.languages ?? query.language);
  const db = getDb();
  const stories = await db.select().from(newsStories)
    .where(languages.length ? primaryLanguageIn(sql`${newsStories.language}`, languages) : undefined)
    .orderBy(desc(newsStories.lastPublishedAt), desc(newsStories.rankingScore)).limit(limit);
  if (stories.length) {
    const articles = await db.select({ storyId: newsStoryArticles.storyId, document: cardColumns })
      .from(newsStoryArticles).innerJoin(searchDocuments, eq(newsStoryArticles.documentId, searchDocuments.id))
      .where(inArray(newsStoryArticles.storyId, stories.map((story) => story.id)));
    const icons = await iconHostsOf(articles.map((item) => item.document));
    return stories.map((story) => ({
      ...story,
      articles: articles.filter((item) => item.storyId === story.id)
        .map((item) => ({ ...publicDocument(item.document, icons), highlights: [], score: 1 })),
    }));
  }
  return singleArticleStories(limit, languages);
}

async function singleArticleStories(limit: number, languages: string[], now = Date.now()) {
  const oldest = now - NEWS_MAX_AGE_DAYS * DAY_MS;
  // A row's stated date may still be unknown to its column (pages crawled
  // before dates were extracted), so the SQL cut is coarse — by publication or
  // index time — and the exact cut happens below, once each date is known.
  const rows = await getDb().select(cardColumns).from(searchDocuments)
    .where(and(
      eq(searchDocuments.documentType, 'news'), eq(searchDocuments.status, 'indexed'), eq(searchDocuments.noindex, false),
      sql`coalesce(${searchDocuments.publishedAt}, ${searchDocuments.indexedAt}) >= ${new Date(oldest).toISOString()}::timestamptz`,
      ...(languages.length ? [primaryLanguageIn(sql`${searchDocuments.language}`, languages)] : []),
    ))
    .orderBy(sql`coalesce(${searchDocuments.publishedAt}, ${searchDocuments.indexedAt}) desc nulls last`)
    .limit(CANDIDATES);
  const seenTitles = new Set<string>();
  const articles = rows.flatMap((row) => {
    const key = row.title?.trim().toLowerCase();
    if (!key || seenTitles.has(key)) return [];
    const document = withStatedMetadata(row, now);
    if (document.publishedAt && document.publishedAt.getTime() < oldest) return [];
    seenTitles.add(key);
    return [document];
  });
  // Dated articles first, newest first; an undated one cannot claim to be new.
  articles.sort((a, b) => (b.publishedAt?.getTime() ?? -Infinity) - (a.publishedAt?.getTime() ?? -Infinity)
    || (b.indexedAt?.getTime() ?? 0) - (a.indexedAt?.getTime() ?? 0));
  const page = articles.slice(0, limit);
  const icons = await iconHostsOf(page);
  return page.map((document) => storyOfOne(document, icons));
}

/**
 * A row's publication date and publisher, falling back to what its page states
 * (JSON-LD, then a date in the URL) when the columns predate their extraction.
 */
function withStatedMetadata(row: DocumentCardRow, now: number): DocumentCardRow {
  if (row.publishedAt && row.publisherName) return row;
  const stated = metadataFromStructuredData(row.structuredData, now);
  return {
    ...row,
    publishedAt: row.publishedAt ?? stated.publishedAt ?? dateFromUrl(row.canonicalUrl, now) ?? null,
    publisherName: row.publisherName ?? stated.publisher ?? null,
  };
}

function storyOfOne(document: DocumentCardRow, icons: ReadonlySet<string>) {
  return {
    id: `document:${document.id}`,
    title: document.title ?? '',
    summary: document.description ?? null,
    language: document.language ?? null,
    firstPublishedAt: document.publishedAt,
    lastPublishedAt: document.publishedAt,
    sourceCount: 1,
    publisherDiversity: 1,
    rankingScore: 0,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    articles: [{ ...publicDocument(document, icons), highlights: [], score: 1 }],
  };
}
