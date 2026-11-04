import { getTableColumns, inArray, type SQL, sql } from 'drizzle-orm';

import { type ClarityExecutor, getDb } from '../db/index.js';
import { searchDocuments, searchDocumentUrls } from '../db/schema/index.js';
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
export type DocumentCardRow = Omit<DocumentRow, 'mainContent' | 'structuredData'> & {
  mainContent?: string | null;
  structuredData?: unknown;
};

// `_mainContent` is dropped on purpose: a card never needs the page text.
const { mainContent: _mainContent, ...cardColumns } = getTableColumns(searchDocuments);

/** The document columns a card needs: everything but the page text. */
export const documentCardColumns = cardColumns;

// A result shows no structured data; only news reads it, for legacy rows.
const { structuredData: _structuredData, ...resultColumns } = cardColumns;

/**
 * Card columns plus the start of the page text, enough for a result's snippet
 * when the page has no description. A page holds up to 5 MB of text; a search
 * read every result's whole text to cut 300 characters from it.
 *
 * A chunked document stores no text (page-text.ts): its first chunk holds the
 * first 2,000 characters, so the snippet's source is cut from that instead.
 */
export const searchResultColumns = {
  ...resultColumns,
  mainContent: sql<string | null>`coalesce(
    left(${searchDocuments.mainContent}, ${SNIPPET_SOURCE_LENGTH}),
    (select left(first_chunk.text, ${SNIPPET_SOURCE_LENGTH}) from clarity_search_chunks first_chunk
      where first_chunk.document_id = clarity_search_documents.id and first_chunk.position = 0)
  )`,
};

/**
 * The documents that answered to any of these URLs. A crawl stores a page under
 * its canonical URL, which a redirect or a `<link rel=canonical>` can make
 * differ from the URL asked for, so the requested and final URLs find it too,
 * and so does every URL a fetch recorded for it (`clarity_search_document_urls`,
 * {@link recordDocumentUrls}). Each branch has its own index: a branch without
 * one makes the whole OR a sequential scan of the table (126k buffers a call in
 * production until 0026). The recorded URLs are read as an array first
 * (`= any(array(...))`): an `in (subquery)` branch is a hashed subplan, which
 * no index serves, and turned the OR into that scan again.
 */
export function answeredToAny(urls: readonly string[]): SQL {
  if (urls.length === 0) return sql`false`;
  const list = sql.join(
    urls.map((url) => sql`${url}`),
    sql`, `,
  );
  return sql`(${inArray(searchDocuments.canonicalUrl, urls)} or ${inArray(searchDocuments.requestedUrl, urls)} or ${inArray(searchDocuments.finalUrl, urls)} or clarity_search_documents.id = any(array(select alias.document_id from clarity_search_document_urls alias where alias.url in (${list}))))`;
}

/** Of these URLs, those a fetch recorded, and the document each produced last. */
export async function documentIdsByUrl(
  executor: ClarityExecutor,
  urls: readonly string[],
): Promise<Map<string, string>> {
  if (urls.length === 0) return new Map();
  const rows = await executor
    .select({ url: searchDocumentUrls.url, documentId: searchDocumentUrls.documentId })
    .from(searchDocumentUrls)
    .where(inArray(searchDocumentUrls.url, [...urls]));
  return new Map(rows.map((row) => [row.url, row.documentId]));
}

/** Records that these URLs reached `documentId`; a URL that reached another document moves. */
export async function recordDocumentUrls(
  executor: ClarityExecutor,
  documentId: string,
  urls: readonly string[],
): Promise<void> {
  const unique = [...new Set(urls)];
  if (unique.length === 0) return;
  await executor
    .insert(searchDocumentUrls)
    .values(unique.map((url) => ({ url, documentId })))
    .onConflictDoUpdate({
      target: searchDocumentUrls.url,
      set: { documentId, updatedAt: new Date() },
    });
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
