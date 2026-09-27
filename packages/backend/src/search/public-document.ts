import { getDb } from '../db/index.js';
import type { searchDocuments } from '../db/schema/index.js';
import { excerpt } from './query-primitives.js';
import { hostOf, hostsWithIcons, siteIconUrl } from './site-icons.js';

/**
 * The public face of an indexed document — one definition, shared by the
 * credentialed `/v1` surface and the anonymous `/news` door, so the two can
 * never disagree about which fields a caller sees.
 */
export type DocumentRow = typeof searchDocuments.$inferSelect;
/** A document read without its page text, as lists that never show it do. */
export type DocumentCardRow = Omit<DocumentRow, 'mainContent'> & { mainContent?: string | null };

/** The hosts among these documents whose favicon Clarity serves. */
export function iconHostsOf(rows: readonly DocumentCardRow[]): Promise<Set<string>> {
  return hostsWithIcons(getDb(), rows.flatMap((row) => hostOf(row.canonicalUrl) ?? []));
}
export function searchResult(row: DocumentRow, score: number, icons: ReadonlySet<string>) {
  return { ...publicDocument(row, icons), snippet: row.description ?? excerpt(row.mainContent), highlights: [], score };
}
/**
 * `faviconUrl` is Clarity's copy of the site's icon (`GET /favicons/:host`),
 * present once the worker has fetched it — never the site's own URL, which a
 * consumer would have to hotlink.
 */
function iconUrlOf(row: DocumentCardRow, icons: ReadonlySet<string>): string | undefined {
  const host = hostOf(row.canonicalUrl);
  return host && icons.has(host) ? siteIconUrl(host) : undefined;
}
export function publicDocument(row: DocumentCardRow, icons: ReadonlySet<string>) {
  return { id: row.id, canonicalUrl: row.canonicalUrl, requestedUrl: row.requestedUrl, title: row.title ?? undefined, description: row.description ?? undefined, content: row.mainContent ?? undefined, type: row.documentType, status: row.status, language: row.language ?? undefined, publisher: row.publisherName ?? undefined, authors: [], publishedAt: row.publishedAt?.toISOString(), modifiedAt: row.modifiedAt?.toISOString(), imageUrl: row.imageUrl ?? undefined, faviconUrl: iconUrlOf(row, icons), indexedAt: row.indexedAt?.toISOString(), evidence: row.fieldEvidence };
}
