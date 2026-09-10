/**
 * Polling the registered public job feeds.
 *
 * This is the supply side of Clarity Jobs: without it the corpus only fills
 * when somebody submits a URL or a publisher pushes a listing. Every endpoint
 * is public and keyless, fetched through the same SSRF-safe client the crawler
 * uses, and each listing keeps its own URL as its canonical source — Clarity
 * indexes these boards, it does not republish them.
 *
 * A feed is polled on its own interval and a failure is recorded on the row
 * rather than thrown, so one dead board cannot stop the others.
 */
import { and, eq, lte, sql } from 'drizzle-orm';
import { safeFetch } from '@oxy.so/core/server';

import type { JobFeedKind } from '@clarity/shared-types';

import { getDb } from '../../../db/index.js';
import { jobFeeds } from '../../../db/schema/index.js';
import { canonicalizePublicUrl } from '../../query-primitives.js';
import { ingestJobPosting } from '../projection.js';
import { parseJobFeed } from './adapters.js';
import { jobFeedAccept, jobFeedUrl } from './endpoints.js';

/** Feeds fetched per maintenance pass. Bounded so one pass stays predictable. */
const FEEDS_PER_PASS = 5;
/** Listings taken from a single response. A board dump is not a crawl budget. */
const MAX_LISTINGS_PER_FEED = 200;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const HEADERS_TIMEOUT_MS = 15_000;

export interface JobFeedPollResult {
  polled: number;
  listings: number;
  failed: number;
}

async function readBody(url: string, kind: JobFeedKind): Promise<string> {
  const result = await safeFetch(url, {
    headers: {
      'User-Agent': 'ClarityBot/0.1 (+https://clarity.surf/bot)',
      accept: jobFeedAccept(kind),
    },
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
    if (bytes > MAX_BODY_BYTES) { result.response.destroy(); throw new Error('feed body too large'); }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Fetches one feed and projects its listings. Returns how many it stored. */
export async function pollJobFeed(feed: typeof jobFeeds.$inferSelect): Promise<number> {
  const observedAt = new Date();
  const requestUrl = jobFeedUrl(feed.kind as JobFeedKind, feed.identifier);
  const body = await readBody(requestUrl, feed.kind as JobFeedKind);
  const listings = parseJobFeed(feed.kind as JobFeedKind, body, {
    kind: feed.kind as JobFeedKind,
    identifier: feed.identifier,
    requestUrl,
    extractedAt: observedAt.toISOString(),
  }).slice(0, MAX_LISTINGS_PER_FEED);

  let stored = 0;
  for (const listing of listings) {
    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalizePublicUrl(listing.canonicalUrl);
    } catch {
      continue; // A listing without a public URL has no canonical source to cite.
    }
    // Each listing is its own document at its own URL, exactly as a crawl of
    // that page would have produced, so both paths deduplicate against each
    // other instead of racing to own the row.
    await ingestJobPosting({
      canonicalUrl,
      structuredData: [{ '@context': 'https://schema.org', '@type': 'JobPosting', ...toJsonLd(listing) }],
      siteId: null,
      sourceType: 'feed',
      observedAt,
    });
    stored += 1;
  }
  return stored;
}

/**
 * The listing is re-expressed as `schema.org/JobPosting` so it re-enters
 * through the one normalizer every source shares. A mapping that skipped this
 * would be a second, silently divergent definition of the same fields.
 */
function toJsonLd(listing: Awaited<ReturnType<typeof parseJobFeed>>[number]): Record<string, unknown> {
  return {
    title: listing.title,
    ...(listing.description ? { description: listing.description } : {}),
    hiringOrganization: {
      '@type': 'Organization',
      name: listing.employerName,
      ...(listing.employerUrl ? { url: listing.employerUrl } : {}),
    },
    ...(listing.locations.length > 0 ? {
      jobLocation: listing.locations.map((location) => ({
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          ...(location.locality ? { addressLocality: location.locality } : {}),
          ...(location.region ? { addressRegion: location.region } : {}),
          ...(location.countryCode ?? location.country ? { addressCountry: location.countryCode ?? location.country } : {}),
        },
      })),
    } : {}),
    ...(listing.workplaceType === 'remote' || listing.workplaceType === 'hybrid' ? { jobLocationType: 'TELECOMMUTE' } : {}),
    ...(listing.applicantLocationRequirements.length > 0 ? {
      applicantLocationRequirements: listing.applicantLocationRequirements.map((name) => ({ '@type': 'Country', name })),
    } : {}),
    ...(listing.employmentTypes.length > 0 ? { employmentType: listing.employmentTypes.map((type) => type.toUpperCase()) } : {}),
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
    ...(listing.identifier ? { identifier: listing.identifier } : {}),
    ...(listing.publishedAt ? { datePosted: listing.publishedAt.toISOString() } : {}),
    ...(listing.validThrough ? { validThrough: listing.validThrough.toISOString() } : {}),
    url: listing.canonicalUrl,
  };
}

/** Polls every feed that is due. One failure never blocks the rest. */
export async function pollDueJobFeeds(): Promise<JobFeedPollResult> {
  const database = getDb();
  const due = await database.select().from(jobFeeds)
    .where(and(eq(jobFeeds.enabled, true), lte(jobFeeds.nextPollAt, new Date())))
    .orderBy(jobFeeds.nextPollAt)
    .limit(FEEDS_PER_PASS);

  const result: JobFeedPollResult = { polled: 0, listings: 0, failed: 0 };
  for (const feed of due) {
    try {
      const stored = await pollJobFeed(feed);
      result.polled += 1;
      result.listings += stored;
      await database.update(jobFeeds).set({
        lastPolledAt: new Date(),
        nextPollAt: sql`now() + (${feed.pollIntervalSeconds} * interval '1 second')`,
        lastStatus: 'ok',
        lastError: null,
        listingsSeen: stored,
        updatedAt: new Date(),
      }).where(eq(jobFeeds.id, feed.id));
    } catch (error) {
      result.failed += 1;
      // Back off a failing feed rather than hammering it every pass.
      await database.update(jobFeeds).set({
        lastPolledAt: new Date(),
        nextPollAt: sql`now() + (${Math.max(feed.pollIntervalSeconds, 3_600)} * interval '1 second')`,
        lastStatus: 'error',
        lastError: (error instanceof Error ? error.message : 'unknown feed failure').slice(0, 500),
        updatedAt: new Date(),
      }).where(eq(jobFeeds.id, feed.id));
    }
  }
  return result;
}
