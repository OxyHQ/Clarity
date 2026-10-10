/**
 * The contract every public job source implements.
 *
 * A provider owns everything specific to one source — where its endpoint is,
 * how its identifier is shaped, how it pages, and how its payload maps onto a
 * normalized listing — so adding a source is one module plus one registry
 * line. Every provider is PUBLIC and KEYLESS: none takes a credential, and a
 * source that needs one does not belong here (see `endpoints.ts`).
 */
import type { JobFeedKind } from '@clarity/shared-types';

import type { ExtractedJobPosting } from '../extract.js';

/** One HTTP request against a provider. GET unless the source only answers POST. */
export interface JobFeedRequest {
  url: string;
  method: 'GET' | 'POST';
  /** JSON request body, for the few sources whose public search is a POST. */
  body?: string;
  accept: string;
}

export interface JobFeedContext {
  kind: JobFeedKind;
  identifier: string;
  /** The URL the payload came from, for resolving relative links. */
  requestUrl: string;
  extractedAt: string;
  /** The page token this payload was requested with; absent for the first page. */
  cursor?: string;
  /**
   * The operator's display name for the feed. Sources that publish no clean
   * employer name (a Lever slug, a Workday legal entity) use it instead.
   */
  label?: string;
}

/** A listing page a source names but does not describe: a sitemap entry, a link on a list page. */
export interface JobFeedPageReference {
  url: string;
  /** The source's own last-modified date; an unchanged page is not read again. */
  lastModified?: Date;
}

/** One page of a source: its listings and, when the source has more, where the next page starts. */
export interface JobFeedPage {
  listings: ExtractedJobPosting[];
  /** Listing pages to read through the provider's `listingPage` reader. */
  references?: JobFeedPageReference[];
  nextCursor?: string;
}

/**
 * Reads one listing page a source only links to — usually the page's own
 * `schema.org/JobPosting`. Pages share the detail budget and cache: a page
 * read within `ttlSeconds`, or not modified since it was read, is re-observed
 * from storage.
 */
export interface JobFeedListingPage {
  parse(html: string, reference: JobFeedPageReference, context: JobFeedContext): ExtractedJobPosting | undefined;
  ttlSeconds?: number;
}

export interface JobFeedIdentifier {
  /** What the identifier means, shown to operators and in errors. */
  meaning: string;
  /**
   * `slug` — a board token or company slug; `url` — an absolute https URL;
   * `none` — the endpoint is a single fixed URL; `optional` — a slug that may be
   * left as the kind name.
   */
  shape: 'slug' | 'url' | 'none' | 'optional';
  /** A stricter pattern than the default slug, for compound identifiers. */
  pattern?: RegExp;
}

/**
 * A per-listing detail endpoint, for sources whose list carries only a summary
 * (no description, no pay). A detail stays current for `ttlSeconds`; until then
 * a re-listed posting is re-observed from what was stored, so a board of
 * thousands of jobs costs thousands of requests once, not on every poll.
 */
export interface JobFeedDetail {
  request(listing: ExtractedJobPosting, identifier: string): JobFeedRequest | undefined;
  /** The listing completed with its detail, or undefined when the detail is not a live posting. */
  parse(body: string, listing: ExtractedJobPosting, context: JobFeedContext): ExtractedJobPosting | undefined;
  ttlSeconds?: number;
  /**
   * The summary is already a complete listing and the detail only enriches it:
   * a summary whose detail is not fetched this poll is stored as listed instead
   * of waiting.
   */
  optional?: boolean;
}

export interface JobFeedProvider {
  kind: JobFeedKind;
  identifier: JobFeedIdentifier;
  /** The request for one page. `cursor` is absent for the first (newest) page. */
  request(identifier: string, cursor?: string): JobFeedRequest;
  parse(body: string, context: JobFeedContext): JobFeedPage;
  detail?: JobFeedDetail;
  listingPage?: JobFeedListingPage;
  /** Detail and listing-page reads per poll, when the source asks for slower pacing than the default. */
  detailsPerPoll?: number;
  /** List pages per poll, the newest included, when the source asks for slower pacing than the default. */
  pagesPerPoll?: number;
  /**
   * A read that reaches the end lists every live posting the source has — a
   * whole ATS board or a full dump, not "the latest N" or a capped search
   * window — so a posting it stops listing has been withdrawn.
   */
  completeListing?: boolean;
  /**
   * The shortest poll interval the source's published terms allow. Registration
   * raises a shorter requested interval to this.
   */
  minPollIntervalSeconds?: number;
  /** The source's own attribution or usage terms, quoted for operators. */
  terms?: string;
  /** Largest response accepted, for sources that publish one whole-board dump. */
  maxBodyBytes?: number;
}
