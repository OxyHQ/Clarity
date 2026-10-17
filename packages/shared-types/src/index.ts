// ---------------------------------------------------------------------------
// @clarity/shared-types
//
// Types shared by BOTH the Clarity frontend (@clarity/frontend) and the
// Clarity backend (@clarity/backend). Import from `@clarity/shared-types`.
//
// Nothing exported here may expose an inference provider, model or route.
// ---------------------------------------------------------------------------

export type {
  CursorPaginated,
  PaginationMeta,
  Paginated,
  ApiErrorResponse,
} from './common.js';

export type {
  JobWorkplaceType,
  JobSeniority,
  JobEmploymentType,
  JobSalaryInterval,
  JobLifecycleStatus,
  JobSourceType,
  JobFeedKind,
  JobFeed,
  RegisterJobFeedRequest,
  JobFieldSource,
  JobSearchMode,
  JobEvidence,
  JobLocation,
  JobSalary,
  JobEmployer,
  JobSource,
  JobPosting,
  JobSearchResult,
  JobSalaryFilter,
  JobSearchRequest,
  JobSearchResponse,
  JobIngestResult,
  JobReportReason,
  JobReportRequest,
} from './jobs.js';

export type {
  MarketSeriesPoint,
  MarketQuoteSummary,
  MarketQuote,
  MarketQuoteError,
  MarketQuoteResult,
  MarketQuotesResponse,
} from './market.js';

export type {
  NewsArticle,
  NewsStory,
  NewsResponse,
} from './news.js';

export type {
  ProductFeed,
  ProductFeedKind,
  ProductFeedRecord,
  ProductFeedRecordPage,
  ProductFeedRegistration,
} from './product-feeds.js';

export type {
  ProductAvailability,
  ProductDetail,
  ProductMoney,
  ProductOffer,
  ProductOfferKind,
  ProductSearchResponse,
  ProductSource,
  ProductSummary,
} from './products.js';
