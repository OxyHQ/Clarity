/**
 * Product feeds: registering them, polling them and serving what they hold.
 *
 * ## A poll is a walk, and only a finished walk prunes
 *
 * A poll reads the feed's next stretch of pages (`pagesPerPoll`), each through
 * `politeRead` — the origin's robots.txt for ClarityBot, its Crawl-delay shared
 * across every feed on that origin, and the provider's own pause. Every document
 * read is upserted with `lastSeenAt` = now; `changedAt` moves only when its
 * content hash does. When a walk reaches the end, the documents it did not see
 * since it began are DELETED: the store stopped listing them, so Clarity stops
 * serving them, and the consumer's own freshness rule retires the offer exactly
 * as if it had read the store itself. A walk cut short by its page budget
 * resumes from its cursor on the next poll, a few minutes later, and prunes
 * nothing until it finishes.
 *
 * ## One reader at a time
 *
 * Due feeds are claimed under `FOR UPDATE SKIP LOCKED` and their next poll is
 * pushed out by the claim, so several workers share them and never walk one
 * feed twice at once.
 */

import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, gt, lt, lte, sql } from 'drizzle-orm';

import type {
  ProductFeed,
  ProductFeedKind,
  ProductFeedRecordPage,
  ProductFeedRegistration,
} from '@clarity/shared-types';
import { getDb } from '../../../db/index.js';
import { productFeedRecords, productFeeds } from '../../../db/schema/index.js';
import { politeRead } from '../../jobs/feeds/poll.js';
import { PRODUCT_FEED_KINDS, productFeedProvider } from './providers.js';

type FeedRow = typeof productFeeds.$inferSelect;

/** How long a claim holds a feed before another worker may take it. */
const CLAIM_SECONDS = 60 * 60;
/** How soon an unfinished walk continues. */
const CONTINUE_SECONDS = 5 * 60;
/** A failing feed is retried no sooner than this. */
const FAILURE_BACKOFF_SECONDS = 6 * 60 * 60;
const FEEDS_PER_ROUND = 4;
/** The most source documents one record page serves. */
export const PRODUCT_FEED_RECORD_PAGE_MAX = 500;
export const PRODUCT_FEED_RECORD_PAGE_DEFAULT = 200;

export class ProductFeedError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: 'invalid_request' | 'product_feed_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'ProductFeedError';
  }
}

function present(row: FeedRow): ProductFeed {
  return {
    id: row.id,
    kind: row.kind as ProductFeedKind,
    identifier: row.identifier,
    label: row.label,
    enabled: row.enabled,
    pollIntervalSeconds: row.pollIntervalSeconds,
    lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
    lastStatus: (row.lastStatus as ProductFeed['lastStatus']) ?? null,
    lastError: row.lastError,
    lastCompletedAt: row.lastCompletedAt?.toISOString() ?? null,
    recordsSeen: row.recordsSeen,
    meta: (row.meta as Record<string, unknown> | null) ?? null,
  };
}

/**
 * Register a feed, or answer the one already registered for the same source.
 * Idempotent on (kind, canonical identifier): a consumer calls it before every
 * read and an operator's existing settings are never overwritten.
 */
export async function registerProductFeed(input: ProductFeedRegistration): Promise<ProductFeed> {
  if (!PRODUCT_FEED_KINDS.includes(input.kind)) {
    throw new ProductFeedError(
      400,
      'invalid_request',
      `kind must be one of ${PRODUCT_FEED_KINDS.join(', ')}`,
    );
  }
  const provider = productFeedProvider(input.kind);
  const identifier = provider.canonicalIdentifier(input.identifier);
  if (identifier === undefined) {
    throw new ProductFeedError(400, 'invalid_request', `identifier must be ${provider.meaning}`);
  }
  const db = getDb();
  await db
    .insert(productFeeds)
    .values({
      id: randomUUID(),
      kind: input.kind,
      identifier,
      ...(input.label ? { label: input.label.slice(0, 200) } : {}),
    })
    .onConflictDoNothing({ target: [productFeeds.kind, productFeeds.identifier] });
  const [row] = await db
    .select()
    .from(productFeeds)
    .where(and(eq(productFeeds.kind, input.kind), eq(productFeeds.identifier, identifier)));
  if (!row) throw new Error('a product feed registration did not persist');
  return present(row);
}

async function feedById(id: string): Promise<FeedRow> {
  const [row] = await getDb().select().from(productFeeds).where(eq(productFeeds.id, id));
  if (!row) throw new ProductFeedError(404, 'product_feed_not_found', 'No such product feed');
  return row;
}

export async function getProductFeed(id: string): Promise<ProductFeed> {
  return present(await feedById(id));
}

function encodeCursor(externalId: string): string {
  return Buffer.from(externalId, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string {
  const externalId = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[\w.:-]{1,128}$/u.test(externalId)) {
    throw new ProductFeedError(400, 'invalid_request', 'cursor is not one this feed issued');
  }
  return externalId;
}

/** One page of a feed's current source documents, by external id. */
export async function listProductFeedRecords(
  id: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<ProductFeedRecordPage> {
  const feed = await feedById(id);
  const limit = Math.min(
    Math.max(options.limit ?? PRODUCT_FEED_RECORD_PAGE_DEFAULT, 1),
    PRODUCT_FEED_RECORD_PAGE_MAX,
  );
  const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
  const rows = await getDb()
    .select()
    .from(productFeedRecords)
    .where(
      and(
        eq(productFeedRecords.feedId, feed.id),
        after === undefined ? undefined : gt(productFeedRecords.externalId, after),
      ),
    )
    .orderBy(asc(productFeedRecords.externalId))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    feed: present(feed),
    records: page.map((row) => ({
      externalId: row.externalId,
      payload: row.payload,
      changedAt: row.changedAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.externalId) : null,
  };
}

function contentHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Read one feed's next stretch; prune and close the walk when it reaches the end. */
export async function pollProductFeed(
  feed: FeedRow,
  now = new Date(),
): Promise<{ stored: number; complete: boolean }> {
  const provider = productFeedProvider(feed.kind as ProductFeedKind);
  const db = getDb();
  const resuming = feed.cursor !== null && feed.walkStartedAt !== null;
  const walkStartedAt = resuming && feed.walkStartedAt ? feed.walkStartedAt : now;

  let meta = feed.meta as Record<string, unknown> | null;
  if (!resuming || meta === null) {
    const request = provider.metaRequest(feed.identifier);
    meta = provider.parseMeta(
      feed.identifier,
      request === null ? null : await politeRead(request, provider.pauseMs),
    );
  }

  let cursor = resuming ? (feed.cursor ?? undefined) : undefined;
  let stored = 0;
  let complete = false;
  for (let page = 0; page < provider.pagesPerPoll; page += 1) {
    const body = await politeRead(provider.pageRequest(feed.identifier, cursor), provider.pauseMs);
    const { documents, nextCursor } = provider.parsePage(body, cursor);
    if (documents.length > 0) {
      const seenAt = new Date();
      await db
        .insert(productFeedRecords)
        .values(
          documents.map((document) => ({
            feedId: feed.id,
            externalId: document.externalId,
            payload: document.payload,
            contentHash: contentHash(document.payload),
            changedAt: seenAt,
            lastSeenAt: seenAt,
          })),
        )
        .onConflictDoUpdate({
          target: [productFeedRecords.feedId, productFeedRecords.externalId],
          set: {
            payload: sql`excluded.payload`,
            changedAt: sql`case when ${productFeedRecords.contentHash} = excluded.content_hash then ${productFeedRecords.changedAt} else excluded.changed_at end`,
            contentHash: sql`excluded.content_hash`,
            lastSeenAt: sql`excluded.last_seen_at`,
          },
        });
      stored += documents.length;
    }
    cursor = nextCursor;
    if (cursor === undefined) {
      complete = true;
      break;
    }
  }

  // A fresh walk that found NOTHING prunes nothing: an empty answer from a
  // store that listed products a moment ago is far likelier an outage than a
  // closed shop, and emptying the catalogue on it would retire every offer.
  const prunes = complete && (resuming || stored > 0);
  if (prunes) {
    await db
      .delete(productFeedRecords)
      .where(
        and(
          eq(productFeedRecords.feedId, feed.id),
          lt(productFeedRecords.lastSeenAt, walkStartedAt),
        ),
      );
  }
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(productFeedRecords)
    .where(eq(productFeedRecords.feedId, feed.id));
  await db
    .update(productFeeds)
    .set({
      meta,
      cursor: complete ? null : (cursor ?? null),
      walkStartedAt: complete ? null : walkStartedAt,
      ...(complete ? { lastCompletedAt: new Date() } : {}),
      lastPolledAt: new Date(),
      lastStatus: 'ok',
      lastError: complete && !prunes ? 'the walk found no products; nothing was pruned' : null,
      recordsSeen: count,
      nextPollAt: sql`now() + (${complete ? feed.pollIntervalSeconds : CONTINUE_SECONDS} * interval '1 second')`,
      updatedAt: new Date(),
    })
    .where(eq(productFeeds.id, feed.id));
  return { stored, complete };
}

/** Claim a round of due feeds under SKIP LOCKED, pushing their next poll out by the claim. */
export async function claimDueProductFeeds(limit = FEEDS_PER_ROUND): Promise<FeedRow[]> {
  return getDb().transaction(async (tx) => {
    const due = await tx
      .select()
      .from(productFeeds)
      .where(and(eq(productFeeds.enabled, true), lte(productFeeds.nextPollAt, new Date())))
      .orderBy(productFeeds.nextPollAt)
      .limit(limit)
      .for('update', { skipLocked: true });
    for (const feed of due) {
      await tx
        .update(productFeeds)
        .set({ nextPollAt: sql`now() + (${CLAIM_SECONDS} * interval '1 second')` })
        .where(eq(productFeeds.id, feed.id));
    }
    return due;
  });
}

export interface ProductFeedPollResult {
  polled: number;
  documents: number;
  failed: number;
}

/** Claims and polls one round of due feeds. One failure never blocks the rest. */
export async function pollDueProductFeeds(): Promise<ProductFeedPollResult> {
  const result: ProductFeedPollResult = { polled: 0, documents: 0, failed: 0 };
  for (const feed of await claimDueProductFeeds()) {
    try {
      const outcome = await pollProductFeed(feed);
      result.polled += 1;
      result.documents += outcome.stored;
    } catch (error) {
      result.failed += 1;
      await getDb()
        .update(productFeeds)
        .set({
          lastPolledAt: new Date(),
          nextPollAt: sql`now() + (${Math.max(feed.pollIntervalSeconds, FAILURE_BACKOFF_SECONDS)} * interval '1 second')`,
          lastStatus: 'error',
          lastError: (error instanceof Error ? error.message : 'unknown feed failure').slice(
            0,
            500,
          ),
          updatedAt: new Date(),
        })
        .where(eq(productFeeds.id, feed.id));
    }
  }
  return result;
}
