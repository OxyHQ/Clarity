import { getTableColumns, inArray, type SQL, sql } from 'drizzle-orm';

import { getDb } from '../db/index.js';
import { searchDocuments } from '../db/schema/index.js';
import { excerpt } from './query-primitives.js';
import { hostOf, hostsWithIcons, siteIconUrl } from './site-icons.js';
import { publicImageUrl } from './image-cache.js';

/**
 * The public face of an indexed document — one definition, shared by the
 * credentialed `/v1` surface and the anonymous `/news` door, so the two can
 * never disagree about which fields a caller sees.
 */
export type DocumentRow = typeof searchDocuments.$inferSelect;

/** How much page text a snippet is cut from (`excerpt` keeps 300 characters). */
const SNIPPET_SOURCE_LENGTH = 1_000;
/** A document read without its page text, as lists that never show it do. */
export type DocumentCardRow = Omit<DocumentRow, 'mainContent'> & { mainContent?: string | null };

// `_mainContent` is dropped on purpose: a card never needs the page text.
const { mainContent: _mainContent, ...cardColumns } = getTableColumns(searchDocuments);

/** The document columns a card needs: everything but the page text. */
export const documentCardColumns = cardColumns;

/**
 * Card columns plus the start of the page text, enough for a result's snippet
 * when the page has no description. A page holds up to 5 MB of text; a search
 * read every result's whole text to cut 300 characters from it.
 */
export const searchResultColumns = {
  ...cardColumns,
  mainContent: sql<string | null>`left(${searchDocuments.mainContent}, ${SNIPPET_SOURCE_LENGTH})`,
};

/**
 * The documents that answered to any of these URLs. A crawl stores a page under
 * its canonical URL, which a redirect or a `<link rel=canonical>` can make
 * differ from the URL asked for, so the requested and final URLs find it too.
 * Each column has its own index: a branch without one makes the whole OR a
 * sequential scan of the table (126k buffers a call in production until 0026).
 */
export function answeredToAny(urls: readonly string[]): SQL {
  return sql`(${inArray(searchDocuments.canonicalUrl, urls)} or ${inArray(searchDocuments.requestedUrl, urls)} or ${inArray(searchDocuments.finalUrl, urls)})`;
}

/** The hosts among these documents whose favicon Clarity serves. */
export function iconHostsOf(rows: readonly DocumentCardRow[]): Promise<Set<string>> {
  return hostsWithIcons(
    getDb(),
    rows.flatMap((row) => hostOf(row.canonicalUrl) ?? []),
  );
}
/**
 * One search result: the document without its page text — `getDocument` and
 * `/v1/documents/:id` return that — plus a snippet, as the SDK's
 * `SearchResult` has always declared it.
 */
export function searchResult(row: DocumentCardRow, score: number, icons: ReadonlySet<string>) {
  const { content: _content, ...document } = publicDocument(row, icons);
  return {
    ...document,
    snippet: row.description ?? excerpt(row.mainContent),
    highlights: [],
    score,
  };
}
/**
 * `faviconUrl` is Clarity's copy of the site's icon (`GET /favicons/:host`),
 * present once the worker has fetched it — never the site's own URL, which a
 * consumer would have to hotlink. `imageUrl` follows the same rule: it is
 * Clarity's copy of the page's preview image (`GET /images/documents/...`,
 * search/image-cache.ts), never the site's own image URL, so a reader's browser
 * never loads anything from the site.
 */
function iconUrlOf(row: DocumentCardRow, icons: ReadonlySet<string>): string | undefined {
  const host = hostOf(row.canonicalUrl);
  return host && icons.has(host) ? siteIconUrl(host) : undefined;
}
export function publicDocument(row: DocumentCardRow, icons: ReadonlySet<string>) {
  return {
    id: row.id,
    canonicalUrl: row.canonicalUrl,
    requestedUrl: row.requestedUrl,
    title: row.title ?? undefined,
    description: row.description ?? undefined,
    content: row.mainContent ?? undefined,
    type: row.documentType,
    status: row.status,
    language: row.language ?? undefined,
    publisher: row.publisherName ?? undefined,
    authors: [],
    publishedAt: row.publishedAt?.toISOString(),
    modifiedAt: row.modifiedAt?.toISOString(),
    imageUrl: publicImageUrl('documents', row.id, row.imageUrl),
    faviconUrl: iconUrlOf(row, icons),
    indexedAt: row.indexedAt?.toISOString(),
    evidence: row.fieldEvidence,
  };
}
