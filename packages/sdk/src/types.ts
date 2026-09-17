import type {
  CountryCode, CurrencyCode, JobEmploymentType, JobLifecycleStatus, JobSalaryInterval, JobWorkplaceType, PlaceKind,
} from './vocabularies.js';

export type SearchMode = 'lexical' | 'semantic' | 'hybrid';
export type DocumentStatus = 'discovered' | 'fetching' | 'extracted' | 'indexed' | 'blocked' | 'failed' | 'removed';
export type DocumentType = 'page' | 'article' | 'news' | 'job' | 'product' | 'video' | 'event' | 'recipe' | 'profile' | 'documentation' | 'other';

/**
 * Status of an asynchronous crawl/index operation.
 *
 * `clarity.jobs` is employment. Crawl and index work is `clarity.operations`.
 */
export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  idempotencyKey?: string;
}

export interface Page<T> {
  data: T[];
  nextCursor?: string;
}

export interface CitationEvidence {
  source: 'html' | 'json_ld' | 'microdata' | 'feed' | 'sitemap' | 'http';
  selector?: string;
  extractedAt: string;
}

export interface Author {
  name: string;
  url?: string;
}

export interface Document {
  id: string;
  canonicalUrl: string;
  requestedUrl?: string;
  title?: string;
  description?: string;
  content?: string;
  type: DocumentType;
  status: DocumentStatus;
  language?: string;
  publisher?: string;
  authors: Author[];
  publishedAt?: string;
  modifiedAt?: string;
  imageUrl?: string;
  faviconUrl?: string;
  indexedAt?: string;
  evidence: Record<string, CitationEvidence>;
}

export interface SearchResult extends Omit<Document, 'content' | 'status'> {
  snippet?: string;
  highlights: string[];
  score: number;
}

export interface SearchRequest {
  query: string;
  mode?: SearchMode;
  types?: DocumentType[];
  domains?: string[];
  language?: string;
  publishedAfter?: string;
  publishedBefore?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchResponse extends Page<SearchResult> {
  mode: SearchMode;
  degraded?: { from: 'hybrid'; to: 'lexical'; reason: string };
}

export interface NewsStory {
  id: string;
  title: string;
  summary?: string;
  language?: string;
  firstPublishedAt: string;
  lastPublishedAt: string;
  sourceCount: number;
  publisherDiversity: number;
  articles: SearchResult[];
}

export interface NewsRequest {
  domains?: string[];
  language?: string;
  publishedAfter?: string;
  limit?: number;
  cursor?: string;
}

export interface IndexUrlsRequest { urls: string[]; }
export interface ResolveRequest { urls: string[]; waitMs?: number; }
export interface ResolveResult { url: string; document?: Document; operationId?: string; status: DocumentStatus | 'queued'; }

/** An asynchronous crawl/index operation — never an employment listing. */
export interface IndexOperation {
  id: string;
  kind: 'urls' | 'site' | 'recrawl' | 'removal';
  status: OperationStatus;
  pagesDiscovered: number;
  pagesCompleted: number;
  error?: { code: string; detail?: string };
  createdAt: string;
  updatedAt: string;
}

export interface Site {
  id: string;
  origin: string;
  verifiedDomainId: string;
  status: 'active' | 'paused' | 'removed';
  crawlEnabled: boolean;
  recrawlIntervalSeconds: number;
  maxPagesPerCrawl: number;
  sitemapUrls: string[];
  feedUrls: string[];
  nextCrawlAt?: string;
}

export interface CreateSiteRequest { origin: string; verifiedDomainId: string; sitemapUrls?: string[]; feedUrls?: string[]; }
export type UpdateSiteRequest = Partial<Pick<Site, 'crawlEnabled' | 'recrawlIntervalSeconds' | 'maxPagesPerCrawl' | 'sitemapUrls' | 'feedUrls' | 'status'>>;
export interface UsageBucket { operation: 'search' | 'fetch_started' | 'page_indexed' | 'browser_render'; quantity: number; periodStart: string; periodEnd: string; }
export interface Quotas { searchesPerMonth: number; fetchesPerMonth: number; sites: number; activeCrawls: number; pagesPerCrawl: number; requestsPerMinuteCredential: number; requestsPerMinuteApplication: number; }

export interface ClarityErrorBody {
  error: { code: string; message: string; requestId: string; details?: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Clarity Jobs — employment search.
//
// Ranking is produced from relevance, freshness, listing completeness and
// duplicate suppression only. No payment, subscription, advertising or other
// commercial state can influence result order.
// ---------------------------------------------------------------------------

export type JobSourceType = 'web' | 'verified_site' | 'first_party';
export type JobFieldSource = 'json_ld' | 'html' | 'feed' | 'api';

export interface JobEvidence { source: JobFieldSource; selector?: string; extractedAt: string; }

export interface JobLocation {
  /** The location as the source wrote it. */
  raw: string;
  /** ISO 3166-1 alpha-2, only when the source stated a recognizable country. */
  countryCode?: CountryCode;
  country?: string;
  region?: string;
  locality?: string;
  postalCode?: string;
  /**
   * GeoNames id of the Clarity {@link Place} this location resolved to — the
   * id the publisher sent, or an unambiguous country-constrained match.
   */
  placeId?: string;
}

export interface JobSalary {
  min?: number;
  max?: number;
  /** ISO 4217. Clarity never converts between currencies. */
  currency: CurrencyCode;
  interval: JobSalaryInterval;
}

export interface JobEmployer { name: string; url?: string; domain?: string; logoUrl?: string; }

/** One place this opening is published. Grouping never discards a source. */
export interface JobSource {
  type: JobSourceType;
  domain: string;
  canonicalUrl: string;
  applyUrl?: string;
  documentId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  status: JobLifecycleStatus;
}

export interface JobPosting {
  id: string;
  documentId: string;
  /** The external listing page. Clarity indexed it; it is not the employer. */
  canonicalUrl: string;
  applyUrl?: string;
  title: string;
  /**
   * Markdown (CommonMark subset: ATX headings, paragraphs, `-` and ordered
   * lists, `**bold**`, `_em_`, `[text](https://…)` links, `\\` hard line
   * breaks). Never contains raw HTML — render it with a Markdown renderer that
   * has HTML disabled. Structure is converted from the source's HTML; no
   * content is added.
   */
  description?: string;
  employer: JobEmployer;
  locations: JobLocation[];
  applicantLocationRequirements: string[];
  workplaceType?: JobWorkplaceType;
  employmentTypes: JobEmploymentType[];
  salary?: JobSalary;
  skills: string[];
  /** Markdown, same contract as `description`. */
  qualifications?: string;
  /** Markdown, same contract as `description`. */
  responsibilities?: string;
  /** Markdown, same contract as `description`. */
  educationRequirements?: string;
  /** Markdown, same contract as `description`. */
  experienceRequirements?: string;
  industry?: string;
  occupationalCategory?: string;
  identifier?: string;
  directApply?: boolean;
  publishedAt?: string;
  validThrough?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  status: JobLifecycleStatus;
  source: JobSource;
  otherSources: JobSource[];
  evidence: Record<string, JobEvidence>;
}

export interface JobSearchResult extends JobPosting {
  /** Plain-text excerpt of the description (no Markdown syntax). */
  snippet?: string;
  score: number;
}

export interface JobSalaryFilter {
  min?: number;
  max?: number;
  /** ISO 4217 from `CURRENCY_CODES`; anything else is a 400. */
  currency?: CurrencyCode;
  interval?: JobSalaryInterval;
}

export interface JobSearchRequest {
  /** Free text. Omit to browse by filters and freshness alone. */
  query?: string;
  mode?: SearchMode;
  /**
   * Country name or ISO 3166-1 alpha-2 code, city or region name, or a
   * macro-region key. A two-letter token must be a code in `COUNTRY_CODES`
   * (or a documented alias such as `UK`), otherwise the request is a 400.
   */
  locations?: string[];
  workplaceTypes?: JobWorkplaceType[];
  employmentTypes?: JobEmploymentType[];
  employers?: string[];
  sourceDomains?: string[];
  skills?: string[];
  salary?: JobSalaryFilter;
  publishedAfter?: string;
  publishedBefore?: string;
  /** Defaults to active only; expired and closed listings are never implied. */
  statuses?: JobLifecycleStatus[];
  includeDuplicates?: boolean;
  limit?: number;
  cursor?: string;
}

export interface JobSearchResponse extends Page<JobSearchResult> {
  mode: SearchMode;
  degraded?: { from: 'hybrid'; to: 'lexical'; reason: string };
}

export interface JobIngestRequest {
  /** Public canonical URL of the listing. */
  url: string;
  /**
   * `schema.org/JobPosting` JSON-LD. Requires a verified Clarity site for the
   * URL's host; without it the call is an ordinary index request.
   *
   * `description` (and `qualifications`, `responsibilities`,
   * `educationRequirements`, `experienceRequirements`) may be HTML — Google's
   * JobPosting convention — or Markdown / plain text. Either way Clarity stores
   * and returns Markdown with no raw HTML.
   */
  jobPosting?: Record<string, unknown> | unknown[];
  /** Set when the publisher has closed the listing. */
  closed?: boolean;
}

export interface JobIngestResult {
  url: string;
  job?: JobPosting;
  operationId?: string;
  status: 'indexed' | 'queued' | 'closed';
}

export type JobReportReason =
  | 'scam' | 'already_filled' | 'duplicate' | 'misleading' | 'discriminatory' | 'other';

/**
 * A reader's report about a listing. Clarity stores no reporter identity, and a
 * report is an operator signal only — it never changes a listing's position.
 */
export interface JobReportRequest {
  reason: JobReportReason;
  detail?: string;
}

export interface JobCorpusStats {
  active: number;
  byStatus: Record<string, number>;
  bySourceType: Record<string, number>;
  withSalary: number;
  grouped: number;
  clusters: number;
}

/** Machine-readable tool descriptor for agents grounding answers in Jobs. */
export interface JobsCapability {
  name: string;
  description: string;
  endpoint: { method: string; path: string; scope: string };
  grounding: Record<string, unknown>;
  ranking: { signals: readonly string[]; commercialSignals: string };
  parameters: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Places — the canonical gazetteer (GeoNames, CC BY 4.0).
// ---------------------------------------------------------------------------

export interface Place {
  /** GeoNames id. Send it back as `https://www.geonames.org/<id>` in a JobPosting's `jobLocation.sameAs`. */
  id: string;
  kind: PlaceKind;
  name: string;
  asciiName: string;
  countryCode: CountryCode;
  /** GeoNames first-order administrative code, e.g. `56` (Catalonia) or `CA` (California). */
  admin1Code?: string;
  admin1Name?: string;
  /** ISO 3166-2 subdivision, only where GeoNames' admin1 code is already that code (e.g. `US-CA`). */
  subdivisionCode?: string;
  /** GeoNames population; absent where GeoNames states none (regions). */
  population?: number;
  latitude?: number;
  longitude?: number;
  /** IANA time zone. */
  timezone?: string;
}

export interface PlaceSearchRequest {
  /** Name prefix (accent- and case-insensitive); close spellings also match. */
  q: string;
  countryCode?: CountryCode;
  kind?: PlaceKind;
  /** 1–50, default 10. */
  limit?: number;
}

export interface PlaceSearchResponse {
  /** Prefix matches first, then by population. */
  data: Place[];
}

