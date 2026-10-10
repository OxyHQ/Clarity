/**
 * Polling the registered public job feeds.
 *
 * This is the supply side of Clarity Jobs: without it the corpus only fills
 * when somebody submits a URL or a publisher pushes a listing. Every endpoint
 * is public and keyless, fetched through the same SSRF-safe client the crawler
 * uses, and each listing keeps its own URL as its canonical source — Clarity
 * indexes these boards, it does not republish them.
 *
 * A paginated source is read HEAD FIRST, then backfilled: every poll reads the
 * newest page, then resumes the deep walk where the previous poll stopped
 * (`clarity_job_feeds.cursor`). New listings therefore never wait behind a
 * long backfill, and a source with tens of thousands of listings is still
 * covered completely over successive polls.
 *
 * A feed is polled on its own interval and a failure is recorded on the row
 * rather than thrown, so one dead board cannot stop the others.
 */
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { safeFetch } from '@oxy.so/core/server';

import type { JobFeedKind } from '@clarity/shared-types';

import { getDb } from '../../../db/index.js';
import { jobFeeds } from '../../../db/schema/index.js';
import { canonicalizePublicUrl } from '../../query-primitives.js';
import type { ExtractedJobPosting } from '../extract.js';
import { ingestJobPosting, storedJobDocument } from '../projection.js';
import { parseJobFeedPage } from './adapters.js';
import { boardFromUrl, type DiscoveredBoard } from './discovery.js';
import { jobFeedRequest } from './endpoints.js';
import { noindex } from './listing.js';
import type { JobFeedContext, JobFeedPage, JobFeedPageReference, JobFeedRequest } from './provider.js';
import { jobFeedProvider } from './registry.js';
import { FEED_USER_AGENT, assertRobotsAllow, robotsAllowUrl } from './robots.js';

/** Feeds claimed per round, and how many of them are polled at once. */
const FEEDS_PER_ROUND = 8;
const POLL_CONCURRENCY = 4;
/** Feeds of one kind per round, so a kind with hundreds of feeds never takes every slot. */
const FEEDS_PER_KIND_PER_ROUND = 2;
/**
 * A claimed feed is not due again for this long, so a second worker never
 * polls it concurrently and a worker that dies mid-poll only delays it.
 */
const CLAIM_SECONDS = 30 * 60;
/** New boards one poll may register by discovery; the rest are found again on later polls. */
const DISCOVERIES_PER_POLL = 25;
/** Pages read from one source in one poll, the newest page included. */
const PAGES_PER_POLL = 10;
/** Listings projected from one source in one poll. A board dump is not a crawl budget. */
const MAX_LISTINGS_PER_POLL = 1_000;
/** Pause between two pages of the same source, so a backfill never bursts. */
const PAGE_DELAY_MS = 1_000;
/** Detail requests per poll, for sources whose list is only a summary. */
const DETAILS_PER_POLL = 150;
/** How long a fetched detail stays current when the source does not say. */
const DETAIL_TTL_SECONDS = 3 * 24 * 60 * 60;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const HEADERS_TIMEOUT_MS = 15_000;

export interface JobFeedPollResult {
  polled: number;
  listings: number;
  failed: number;
  discovered: number;
}

/** A board found through a feed's listings, with the employer name its listings gave. */
export interface DiscoveredFeed extends DiscoveredBoard {
  label: string;
}

export interface JobFeedPollOutcome {
  /** Listings projected this poll. */
  stored: number;
  /** Listings the source returned that could not be projected. */
  rejected: number;
  /** Where the next poll resumes the backfill, or null when the walk reached the end. */
  cursor: string | null;
  /** ATS boards the listings link to that this feed is not itself. */
  discovered: DiscoveredFeed[];
}

async function readBody(request: JobFeedRequest, maxBodyBytes = MAX_BODY_BYTES): Promise<string> {
  const result = await safeFetch(request.url, {
    method: request.method,
    headers: {
      'User-Agent': FEED_USER_AGENT,
      accept: request.accept,
      ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(request.body === undefined ? {} : { body: request.body }),
    maxRedirects: 3,
    headersTimeoutMs: HEADERS_TIMEOUT_MS,
  });
  if (result.status !== 200) {
    result.response.destroy();
    throw new Error(`feed responded ${result.status}`);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of result.response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBodyBytes) { result.response.destroy(); throw new Error('feed body too large'); }
    chunks.push(buffer);
  }
  return decodeBody(Buffer.concat(chunks), result.response.headers['content-type']);
}

/**
 * The body in the charset its Content-Type declares (many public-sector sites
 * still serve windows-1252), UTF-8 when it declares none or one the runtime
 * does not know.
 */
export function decodeBody(body: Buffer, contentType: string | string[] | undefined): string {
  const header = Array.isArray(contentType) ? contentType[0] : contentType;
  const charset = /charset\s*=\s*"?([\w-]+)/i.exec(header ?? '')?.[1]?.toLowerCase();
  if (charset && charset !== 'utf-8' && charset !== 'utf8') {
    try {
      return new TextDecoder(charset).decode(body);
    } catch {
      // An unknown label falls through to UTF-8.
    }
  }
  return body.toString('utf8');
}

/**
 * When each origin may next be requested. Feeds are polled concurrently and
 * many share an origin (every EURES slice is europa.eu), so an origin's
 * Crawl-delay is honoured across all of them, not per feed.
 */
const originSlots = new Map<string, number>();

/** Reserves the origin's next request slot and returns how long to wait for it. */
function reserveOriginSlot(origin: string, gapMs: number): number {
  const now = Date.now();
  const at = Math.max(now, originSlots.get(origin) ?? 0);
  originSlots.set(origin, at + gapMs);
  return at - now;
}

/** Reads a request the origin's robots.txt allows, after the pause the origin and this feed ask for. */
async function politeRead(request: JobFeedRequest, pauseMs: number, maxBodyBytes?: number): Promise<string> {
  const crawlDelaySeconds = await assertRobotsAllow(request.url);
  const wait = Math.max(pauseMs, reserveOriginSlot(new URL(request.url).origin, crawlDelaySeconds * 1000));
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return readBody(request, maxBodyBytes);
}

async function readPage(feed: typeof jobFeeds.$inferSelect, observedAt: Date, pauseMs: number, cursor?: string): Promise<JobFeedPage> {
  const kind = feed.kind as JobFeedKind;
  const request = jobFeedRequest(kind, feed.identifier, cursor);
  const body = await politeRead(request, pauseMs, jobFeedProvider(kind).maxBodyBytes);
  return parseJobFeedPage(kind, body, {
    kind,
    identifier: feed.identifier,
    requestUrl: request.url,
    extractedAt: observedAt.toISOString(),
    ...(cursor === undefined ? {} : { cursor }),
    ...(feed.label ? { label: feed.label } : {}),
  });
}

/** Fetches one feed — its newest page, then the next stretch of its backfill — and projects the listings. */
export async function pollJobFeed(
  feed: typeof jobFeeds.$inferSelect,
  { pageDelayMs = PAGE_DELAY_MS }: { pageDelayMs?: number } = {},
): Promise<JobFeedPollOutcome> {
  const observedAt = new Date();
  const kind = feed.kind as JobFeedKind;
  const { detail, listingPage, detailsPerPoll, pagesPerPoll } = jobFeedProvider(kind);
  const seen = new Set<string>();
  const outcome: JobFeedPollOutcome = { stored: 0, rejected: 0, cursor: null, discovered: [] };
  const boards = new Set<string>([`${feed.kind}:${feed.identifier}`]);
  const discover = (listing: ExtractedJobPosting): void => {
    for (const board of [boardFromUrl(listing.applyUrl), boardFromUrl(listing.canonicalUrl)]) {
      if (!board || boards.has(`${board.kind}:${board.identifier}`)) continue;
      boards.add(`${board.kind}:${board.identifier}`);
      outcome.discovered.push({ ...board, label: listing.employerName });
    }
  };
  let detailBudget = detailsPerPoll ?? DETAILS_PER_POLL;

  /**
   * The listing as it should be stored: as listed, or completed by its detail
   * endpoint. A detail still current is not fetched again — the stored
   * payload is re-observed instead. Undefined means "not this poll".
   */
  const complete = async (listing: ExtractedJobPosting, canonicalUrl: string): Promise<{ structuredData: unknown[]; fetchedAt?: Date } | undefined> => {
    if (!detail) return { structuredData: [jobPostingLd(listing)] };
    const stored = await storedJobDocument(canonicalUrl);
    const ttlMs = (detail.ttlSeconds ?? DETAIL_TTL_SECONDS) * 1000;
    if (stored?.fetchedAt && observedAt.getTime() - stored.fetchedAt.getTime() < ttlMs) {
      return { structuredData: stored.structuredData, fetchedAt: stored.fetchedAt };
    }
    const request = detail.request(listing, feed.identifier);
    if (!request || detailBudget <= 0) {
      if (stored) return { structuredData: stored.structuredData, ...(stored.fetchedAt ? { fetchedAt: stored.fetchedAt } : {}) };
      return detail.optional ? { structuredData: [jobPostingLd(listing)] } : undefined;
    }
    detailBudget -= 1;
    try {
      const body = await politeRead(request, pageDelayMs);
      const completed = detail.parse(body, listing, contextFor(request.url));
      return completed ? { structuredData: [jobPostingLd(completed)] } : undefined;
    } catch {
      // A detail that cannot be read now is retried next poll; a stale copy
      // is better than none in the meantime.
      if (stored) return { structuredData: stored.structuredData, ...(stored.fetchedAt ? { fetchedAt: stored.fetchedAt } : {}) };
      return detail.optional ? { structuredData: [jobPostingLd(listing)] } : undefined;
    }
  };

  const contextFor = (requestUrl: string): JobFeedContext => ({
    kind, identifier: feed.identifier, requestUrl, extractedAt: observedAt.toISOString(),
    ...(feed.label ? { label: feed.label } : {}),
  });

  /** A page the source only links to, read through its own JSON-LD unless what is stored is still current. */
  const readReference = async (reference: JobFeedPageReference, canonicalUrl: string): Promise<{ structuredData: unknown[]; fetchedAt?: Date } | undefined> => {
    if (!listingPage) return undefined;
    const stored = await storedJobDocument(canonicalUrl);
    const ttlMs = (listingPage.ttlSeconds ?? DETAIL_TTL_SECONDS) * 1000;
    const unchanged = stored?.fetchedAt && reference.lastModified && reference.lastModified <= stored.fetchedAt;
    if (stored?.fetchedAt && (unchanged || observedAt.getTime() - stored.fetchedAt.getTime() < ttlMs)) {
      return { structuredData: stored.structuredData, fetchedAt: stored.fetchedAt };
    }
    if (detailBudget <= 0) return undefined;
    detailBudget -= 1;
    try {
      const html = await politeRead({ url: canonicalUrl, method: 'GET', accept: 'text/html,application/xhtml+xml' }, pageDelayMs);
      // A page that asks not to be indexed is not indexed.
      if (noindex(html)) return undefined;
      const read = listingPage.parse(html, reference, contextFor(canonicalUrl));
      return read ? { structuredData: [jobPostingLd(read)] } : undefined;
    } catch {
      return stored ? { structuredData: stored.structuredData, ...(stored.fetchedAt ? { fetchedAt: stored.fetchedAt } : {}) } : undefined;
    }
  };

  const projectReferences = async (references: readonly JobFeedPageReference[]): Promise<void> => {
    for (const reference of references) {
      if (seen.size >= MAX_LISTINGS_PER_POLL) return;
      let canonicalUrl: string;
      try {
        canonicalUrl = canonicalizePublicUrl(reference.url);
      } catch {
        outcome.rejected += 1;
        continue;
      }
      if (seen.has(canonicalUrl)) continue;
      seen.add(canonicalUrl);
      if (!await robotsAllowUrl(canonicalUrl)) continue;
      try {
        const payload = await readReference(reference, canonicalUrl);
        if (!payload) continue;
        await ingestJobPosting({
          canonicalUrl, structuredData: payload.structuredData, siteId: null, sourceType: 'feed', fieldSource: 'feed', observedAt,
          ...(payload.fetchedAt ? { fetchedAt: payload.fetchedAt } : {}),
        });
        outcome.stored += 1;
      } catch {
        outcome.rejected += 1;
      }
    }
  };

  const project = async (listings: readonly ExtractedJobPosting[]): Promise<void> => {
    for (const listing of listings) {
      if (seen.size >= MAX_LISTINGS_PER_POLL) return;
      let canonicalUrl: string;
      try {
        canonicalUrl = canonicalizePublicUrl(listing.canonicalUrl);
      } catch {
        outcome.rejected += 1;
        continue; // A listing without a public URL has no canonical source to cite.
      }
      // Offset-paged sources shift while they are walked; a listing seen on
      // two pages of one poll is projected once.
      if (seen.has(canonicalUrl)) continue;
      seen.add(canonicalUrl);
      discover(listing);
      // The listing's own page is governed by its own origin's robots.txt.
      if (!await robotsAllowUrl(canonicalUrl)) continue;
      try {
        const payload = await complete(listing, canonicalUrl);
        if (!payload) continue;
        // Each listing is its own document at its own URL, exactly as a crawl
        // of that page would have produced, so both paths deduplicate against
        // each other instead of racing to own the row.
        await ingestJobPosting({
          canonicalUrl,
          structuredData: payload.structuredData,
          siteId: null,
          sourceType: 'feed',
          fieldSource: 'feed',
          observedAt,
          ...(payload.fetchedAt ? { fetchedAt: payload.fetchedAt } : {}),
        });
        outcome.stored += 1;
      } catch {
        // One malformed listing never costs the rest of the feed.
        outcome.rejected += 1;
      }
    }
  };

  const head = await readPage(feed, observedAt, 0);
  await project(head.listings);
  await projectReferences(head.references ?? []);
  if (outcome.rejected > 0 && outcome.stored === 0) throw new Error('no listing in the feed could be projected');

  // A single-page source has nothing to resume. Otherwise continue the
  // backfill where the last poll stopped, or start it after the head page.
  let cursor = head.nextCursor ? (feed.cursor ?? head.nextCursor) : undefined;
  let pages = 1;
  while (cursor && pages < (pagesPerPoll ?? PAGES_PER_POLL) && seen.size < MAX_LISTINGS_PER_POLL) {
    let next: JobFeedPage;
    try {
      next = await readPage(feed, observedAt, pageDelayMs, cursor);
    } catch {
      // A cursor the source rejects on resume has expired: the walk restarts
      // from the top next time. A failure deeper in this walk is kept, so a
      // transient error does not throw away the progress made.
      if (cursor === feed.cursor) cursor = undefined;
      break;
    }
    pages += 1;
    await project(next.listings);
    await projectReferences(next.references ?? []);
    cursor = next.listings.length > 0 || (next.references?.length ?? 0) > 0 ? next.nextCursor : undefined;
  }
  outcome.cursor = cursor ?? null;
  return outcome;
}

function jobPostingLd(listing: ExtractedJobPosting): Record<string, unknown> {
  return { '@context': 'https://schema.org', '@type': 'JobPosting', ...toJsonLd(listing) };
}

/**
 * The listing is re-expressed as `schema.org/JobPosting` so it re-enters
 * through the one normalizer every source shares. A mapping that skipped this
 * would be a second, silently divergent definition of the same fields. The
 * three non-schema.org keys (`workplaceType`, `seniority`, `directApplyUrl`)
 * are the ones that normalizer reads for exactly this purpose.
 */
export function toJsonLd(listing: ExtractedJobPosting): Record<string, unknown> {
  return {
    title: listing.title,
    ...(listing.description ? { description: listing.description } : {}),
    hiringOrganization: {
      '@type': 'Organization',
      name: listing.employerName,
      ...(listing.employerUrl ? { url: listing.employerUrl } : {}),
      ...(listing.employerLogoUrl ? { logo: listing.employerLogoUrl } : {}),
    },
    ...(listing.locations.length > 0 ? {
      jobLocation: listing.locations.map((location) => {
        // The code, when there is one, is what every reader resolves; a
        // country name is only as good as the normalizer's vocabulary.
        const country = location.countryCode ?? location.country;
        const structured = Boolean(location.locality || location.region || country);
        return {
          '@type': 'Place',
          // A location the source gave only as text stays that text, and a
          // structured one keeps the source's wording as its name.
          address: structured ? {
            '@type': 'PostalAddress',
            name: location.raw,
            ...(location.locality ? { addressLocality: location.locality } : {}),
            ...(location.region ? { addressRegion: location.region } : {}),
            ...(country ? { addressCountry: country } : {}),
            ...(location.postalCode ? { postalCode: location.postalCode } : {}),
          } : location.raw,
        };
      }),
    } : {}),
    ...(listing.workplaceType === 'remote' || listing.workplaceType === 'hybrid' ? { jobLocationType: 'TELECOMMUTE' } : {}),
    ...(listing.workplaceType ? { workplaceType: listing.workplaceType } : {}),
    ...(listing.applicantLocationRequirements.length > 0 ? {
      applicantLocationRequirements: listing.applicantLocationRequirements.map((name) => ({ '@type': 'Country', name })),
    } : {}),
    ...(listing.employmentTypes.length > 0 ? { employmentType: listing.employmentTypes.map((type) => type.toUpperCase()) } : {}),
    ...(listing.seniority ? { seniority: listing.seniority } : {}),
    ...(listing.salary ? {
      baseSalary: {
        '@type': 'MonetaryAmount',
        currency: listing.salary.currency,
        value: {
          '@type': 'QuantitativeValue',
          ...(listing.salary.min === undefined ? {} : { minValue: listing.salary.min }),
          ...(listing.salary.max === undefined ? {} : { maxValue: listing.salary.max }),
          unitText: listing.salary.interval.toUpperCase(),
        },
      },
    } : {}),
    ...(listing.skills.length > 0 ? { skills: listing.skills.join(', ') } : {}),
    ...(listing.qualifications ? { qualifications: listing.qualifications } : {}),
    ...(listing.responsibilities ? { responsibilities: listing.responsibilities } : {}),
    ...(listing.educationRequirements ? { educationRequirements: listing.educationRequirements } : {}),
    ...(listing.experienceRequirements ? { experienceRequirements: listing.experienceRequirements } : {}),
    ...(listing.benefits ? { jobBenefits: listing.benefits } : {}),
    ...(listing.industry ? { industry: listing.industry } : {}),
    ...(listing.occupationalCategory ? { occupationalCategory: listing.occupationalCategory } : {}),
    ...(listing.department ? { employmentUnit: { '@type': 'Organization', name: listing.department } } : {}),
    ...(listing.identifier ? { identifier: listing.identifier } : {}),
    ...(listing.directApply === undefined ? {} : { directApply: listing.directApply }),
    ...(listing.publishedAt ? { datePosted: listing.publishedAt.toISOString() } : {}),
    ...(listing.validThrough ? { validThrough: listing.validThrough.toISOString() } : {}),
    url: listing.canonicalUrl,
    ...(listing.applyUrl && listing.applyUrl !== listing.canonicalUrl ? { directApplyUrl: listing.applyUrl } : {}),
  };
}

/**
 * Claims up to `limit` due feeds for this worker: each is pushed out of the
 * due window before it is polled, under SKIP LOCKED, so concurrent workers
 * never pick the same feed.
 */
export async function claimDueFeeds(limit: number): Promise<Array<typeof jobFeeds.$inferSelect>> {
  return getDb().transaction(async (tx) => {
    // The longest-waiting feeds of each kind, at most a couple per kind.
    const ranked = tx.select({
      id: jobFeeds.id,
      rank: sql<number>`row_number() over (partition by ${jobFeeds.kind} order by ${jobFeeds.nextPollAt})`.as('rank'),
    }).from(jobFeeds)
      .where(and(eq(jobFeeds.enabled, true), lte(jobFeeds.nextPollAt, new Date())))
      .as('ranked');
    const due = await tx.select().from(jobFeeds)
      .where(inArray(jobFeeds.id, tx.select({ id: ranked.id }).from(ranked).where(lte(ranked.rank, FEEDS_PER_KIND_PER_ROUND))))
      .orderBy(jobFeeds.nextPollAt)
      .limit(limit)
      .for('update', { skipLocked: true });
    if (due.length > 0) {
      await tx.update(jobFeeds)
        .set({ nextPollAt: sql`now() + (${CLAIM_SECONDS} * interval '1 second')` })
        .where(inArray(jobFeeds.id, due.map((feed) => feed.id)));
    }
    return due;
  });
}

/**
 * Registers boards found through a feed. A board already registered — by an
 * operator or an earlier discovery — is left exactly as it is, disabled ones
 * included.
 */
async function registerDiscoveredFeeds(from: typeof jobFeeds.$inferSelect, found: readonly DiscoveredFeed[]): Promise<number> {
  if (found.length === 0) return 0;
  const inserted = await getDb().insert(jobFeeds)
    .values(found.slice(0, DISCOVERIES_PER_POLL).map((board) => ({
      id: crypto.randomUUID(),
      kind: board.kind,
      identifier: board.identifier,
      label: board.label.slice(0, 200),
      discoveredFromFeedId: from.id,
    })))
    .onConflictDoNothing({ target: [jobFeeds.kind, jobFeeds.identifier] })
    .returning({ id: jobFeeds.id });
  return inserted.length;
}

async function pollClaimedFeed(feed: typeof jobFeeds.$inferSelect, result: JobFeedPollResult): Promise<void> {
  const database = getDb();
  try {
    const outcome = await pollJobFeed(feed);
    result.polled += 1;
    result.listings += outcome.stored;
    await database.update(jobFeeds).set({
      lastPolledAt: new Date(),
      nextPollAt: sql`now() + (${feed.pollIntervalSeconds} * interval '1 second')`,
      lastStatus: 'ok',
      lastError: outcome.rejected > 0 ? `${outcome.rejected} listing(s) could not be projected` : null,
      listingsSeen: outcome.stored,
      cursor: outcome.cursor,
      updatedAt: new Date(),
    }).where(eq(jobFeeds.id, feed.id));
    result.discovered += await registerDiscoveredFeeds(feed, outcome.discovered);
  } catch (error) {
    result.failed += 1;
    // A discovered board that does not exist was a wrong guess about a URL,
    // not an outage: it is switched off rather than retried forever. An
    // operator's own registration only ever backs off.
    const missing = error instanceof Error && /^feed responded (?:404|410)$/.test(error.message);
    // Back off a failing feed rather than hammering it every pass.
    await database.update(jobFeeds).set({
      ...(missing && feed.discoveredFromFeedId ? { enabled: false } : {}),
      lastPolledAt: new Date(),
      nextPollAt: sql`now() + (${Math.max(feed.pollIntervalSeconds, 3_600)} * interval '1 second')`,
      lastStatus: 'error',
      lastError: (error instanceof Error ? error.message : 'unknown feed failure').slice(0, 500),
      updatedAt: new Date(),
    }).where(eq(jobFeeds.id, feed.id));
  }
}

/** Claims and polls one round of due feeds, a few at a time. One failure never blocks the rest. */
export async function pollDueJobFeeds(): Promise<JobFeedPollResult> {
  const result: JobFeedPollResult = { polled: 0, listings: 0, failed: 0, discovered: 0 };
  const queue = await claimDueFeeds(FEEDS_PER_ROUND);
  await Promise.all(Array.from({ length: Math.min(POLL_CONCURRENCY, queue.length) }, async () => {
    for (let feed = queue.shift(); feed; feed = queue.shift()) await pollClaimedFeed(feed, result);
  }));
  return result;
}
