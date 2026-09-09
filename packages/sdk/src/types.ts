export type SearchMode = 'lexical' | 'semantic' | 'hybrid';
export type DocumentStatus = 'discovered' | 'fetching' | 'extracted' | 'indexed' | 'blocked' | 'failed' | 'removed';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
export type DocumentType = 'page' | 'article' | 'news' | 'product' | 'video' | 'event' | 'recipe' | 'profile' | 'documentation' | 'other';

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
export interface ResolveResult { url: string; document?: Document; jobId?: string; status: DocumentStatus | 'queued'; }

export interface Job {
  id: string;
  kind: 'urls' | 'site' | 'recrawl' | 'removal';
  status: JobStatus;
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
