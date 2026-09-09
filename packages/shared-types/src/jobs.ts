// ---------------------------------------------------------------------------
// Clarity Jobs — the employment search vertical.
//
// These types describe PUBLIC job postings that Clarity discovered, extracted
// and normalized. They are a SEARCH REPRESENTATION: for externally authored
// listings the canonical source page remains authoritative, and Clarity never
// presents itself as the employer.
//
// Nothing here may carry applicant data, application state or any commercial
// relationship between an employer and Oxy. See docs/jobs.mdx.
// ---------------------------------------------------------------------------

/** How a role is performed, only when the source states it explicitly. */
export type JobWorkplaceType = 'remote' | 'hybrid' | 'onsite';

/** Normalized `schema.org/JobPosting.employmentType`. */
export type JobEmploymentType =
  | 'full_time'
  | 'part_time'
  | 'contract'
  | 'temporary'
  | 'internship'
  | 'volunteer'
  | 'per_diem'
  | 'other';

/** Normalized `schema.org/MonetaryAmount.unitText`. */
export type JobSalaryInterval = 'hour' | 'day' | 'week' | 'month' | 'year';

/**
 * Lifecycle of a listing inside Clarity's corpus.
 *
 * - `active`   — seen recently and not past `validThrough`.
 * - `expired`  — the source declared a `validThrough` that has passed.
 * - `closed`   — the source withdrew it (404/410, or the page no longer
 *                carries a `JobPosting`, or a first-party close signal).
 * - `removed`  — the underlying document was removed or blocked in Clarity.
 * - `stale`    — no explicit expiry and not re-observed within the documented
 *                staleness window.
 */
export type JobLifecycleStatus = 'active' | 'expired' | 'closed' | 'removed' | 'stale';

/** Where a listing entered the corpus from. Never a ranking input. */
export type JobSourceType = 'web' | 'verified_site' | 'first_party';

/** Which extraction surface produced a normalized field. */
export type JobFieldSource = 'json_ld' | 'html' | 'feed' | 'api';

export type JobSearchMode = 'lexical' | 'semantic' | 'hybrid';

/** Provenance for one normalized field. */
export interface JobEvidence {
  source: JobFieldSource;
  selector?: string;
  extractedAt: string;
}

export interface JobLocation {
  /** The location exactly as the source expressed it. */
  raw: string;
  /** ISO 3166-1 alpha-2, only when the source value resolves unambiguously. */
  countryCode?: string;
  country?: string;
  region?: string;
  locality?: string;
  postalCode?: string;
}

export interface JobSalary {
  min?: number;
  max?: number;
  /** ISO 4217, uppercase. Clarity never converts between currencies. */
  currency: string;
  interval: JobSalaryInterval;
}

export interface JobEmployer {
  name: string;
  url?: string;
  domain?: string;
  logoUrl?: string;
}

/** One place this exact opening is published. Never discarded by dedupe. */
export interface JobSource {
  type: JobSourceType;
  /** Host of the canonical listing URL. */
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
  /** The Clarity search document this projection was extracted from. */
  documentId: string;
  /** The listing's own canonical URL — always an external source we indexed. */
  canonicalUrl: string;
  applyUrl?: string;

  title: string;
  description?: string;
  employer: JobEmployer;

  locations: JobLocation[];
  /** `applicantLocationRequirements` for remote roles, as stated. */
  applicantLocationRequirements: string[];
  workplaceType?: JobWorkplaceType;
  employmentTypes: JobEmploymentType[];

  salary?: JobSalary;

  skills: string[];
  qualifications?: string;
  responsibilities?: string;
  educationRequirements?: string;
  experienceRequirements?: string;
  industry?: string;
  occupationalCategory?: string;

  /** Source-declared requisition/identifier, used for conservative dedupe. */
  identifier?: string;
  directApply?: boolean;

  publishedAt?: string;
  validThrough?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  status: JobLifecycleStatus;

  /** The canonical source Clarity shows for this opening. */
  source: JobSource;
  /** Every other source in the same duplicate group, provenance preserved. */
  otherSources: JobSource[];

  evidence: Record<string, JobEvidence>;
}

export interface JobSearchResult extends JobPosting {
  /** Evidence-grounded excerpt taken from the indexed listing text. */
  snippet?: string;
  score: number;
}

export interface JobSalaryFilter {
  min?: number;
  max?: number;
  currency?: string;
  interval?: JobSalaryInterval;
}

export interface JobSearchRequest {
  /** Free text. Omit to browse by filters and freshness only. */
  query?: string;
  mode?: JobSearchMode;
  /** Country codes/names, region keys (`europe`, `latin_america`, …) or free text. */
  locations?: string[];
  workplaceTypes?: JobWorkplaceType[];
  employmentTypes?: JobEmploymentType[];
  /** Employer display name or employer domain. */
  employers?: string[];
  /** Host of the listing URL, for source-scoped queries. */
  sourceDomains?: string[];
  skills?: string[];
  salary?: JobSalaryFilter;
  publishedAfter?: string;
  publishedBefore?: string;
  /** Defaults to `['active']`; expired/closed listings are never implied. */
  statuses?: JobLifecycleStatus[];
  /** Return every syndicated copy instead of one grouped result. */
  includeDuplicates?: boolean;
  limit?: number;
  cursor?: string;
}

export interface JobSearchResponse {
  data: JobSearchResult[];
  mode: JobSearchMode;
  degraded?: { from: 'hybrid'; to: 'lexical'; reason: string };
  nextCursor?: string;
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

/** Result of handing Clarity a first-party or newly published listing. */
export interface JobIngestResult {
  url: string;
  /** Present once the listing has a normalized projection. */
  job?: JobPosting;
  /** Present when Clarity queued a crawl to verify or discover the listing. */
  operationId?: string;
  status: 'indexed' | 'queued' | 'closed';
}
