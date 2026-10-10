/**
 * Withdrawal by absence.
 *
 * A source that lists its whole board on every poll (an ATS board, a full XML
 * dump) proves a listing withdrawn simply by no longer listing it. After such
 * a complete read, every document this feed listed before but not now is
 * closed with `posting_absent` — unless another feed still lists the same page,
 * in which case the listing is still out there. A listing that reappears is
 * reopened by its next ingest like any re-observed listing.
 *
 * Sources whose reads are windowed or "latest N" (most RSS, freehire, EURES,
 * Workday) never prove absence, and their listings age out through the
 * lifecycle's staleness window instead.
 */
import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm';

import { getDb } from '../../../db/index.js';
import { jobFeedListings, searchDocuments } from '../../../db/schema/index.js';
import { closeJobPostingsForDocument } from '../projection.js';

/** Another feed that listed a page this recently keeps it open. */
const OTHER_FEED_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
/** Canonical URLs matched per statement, so a 10,000-listing dump stays a few round trips. */
const CHUNK = 2_000;

/**
 * Records that `feedId` listed these canonical URLs at `observedAt`. Only
 * documents Clarity has indexed are linked; a listing not stored yet has
 * nothing to close.
 */
export async function recordFeedPresence(
  feedId: string,
  canonicalUrls: readonly string[],
  observedAt: Date,
): Promise<void> {
  const database = getDb();
  for (let start = 0; start < canonicalUrls.length; start += CHUNK) {
    const urls = canonicalUrls.slice(start, start + CHUNK);
    await database.execute(sql`
      insert into ${jobFeedListings} (feed_id, document_id, last_seen_at)
      select ${feedId}, ${searchDocuments.id}, ${observedAt.toISOString()}::timestamptz
      from ${searchDocuments}
      where ${searchDocuments.canonicalUrl} in ${urls}
      on conflict (feed_id, document_id) do update set last_seen_at = excluded.last_seen_at`);
  }
}

/**
 * After a complete read: closes what this feed listed before and no longer
 * does, and forgets those links. Returns how many documents were closed.
 */
export async function closeAbsentListings(feedId: string, observedAt: Date): Promise<number> {
  const database = getDb();
  const absent = await database
    .select({ documentId: jobFeedListings.documentId })
    .from(jobFeedListings)
    .where(and(eq(jobFeedListings.feedId, feedId), lt(jobFeedListings.lastSeenAt, observedAt)));
  if (absent.length === 0) return 0;
  const absentIds = absent.map((row) => row.documentId);
  const stillListed = await database
    .select({ documentId: jobFeedListings.documentId })
    .from(jobFeedListings)
    .where(
      and(
        inArray(jobFeedListings.documentId, absentIds),
        ne(jobFeedListings.feedId, feedId),
        sql`${jobFeedListings.lastSeenAt} > ${new Date(observedAt.getTime() - OTHER_FEED_GRACE_MS).toISOString()}::timestamptz`,
      ),
    );
  const keep = new Set(stillListed.map((row) => row.documentId));
  let closed = 0;
  for (const documentId of absentIds) {
    if (keep.has(documentId)) continue;
    closed += await database.transaction((tx) =>
      closeJobPostingsForDocument(tx, documentId, 'posting_absent'),
    );
  }
  await database
    .delete(jobFeedListings)
    .where(and(eq(jobFeedListings.feedId, feedId), lt(jobFeedListings.lastSeenAt, observedAt)));
  return closed;
}

/** Closes the listing at a URL whose own source answered that it is gone (404/410). */
export async function closeGoneListing(canonicalUrl: string): Promise<void> {
  const [document] = await getDb()
    .select({ id: searchDocuments.id })
    .from(searchDocuments)
    .where(eq(searchDocuments.canonicalUrl, canonicalUrl))
    .limit(1);
  if (document)
    await getDb().transaction((tx) => closeJobPostingsForDocument(tx, document.id, 'http_gone'));
}
