/**
 * `GET /news` — the public news surface behind Discover.
 *
 * A story is a cluster of articles about one event; until clustering runs, a
 * story is a single crawled news article. The shape is the same either way.
 */
export interface NewsArticle {
  id: string;
  canonicalUrl: string;
  title?: string;
  description?: string;
  publisher?: string;
  language?: string;
  publishedAt?: string;
  imageUrl?: string;
  /** Clarity's copy of the site's icon, once fetched. Never the site's own URL. */
  faviconUrl?: string;
}

export interface NewsStory {
  id: string;
  title: string;
  summary: string | null;
  language: string | null;
  firstPublishedAt: string;
  lastPublishedAt: string;
  /**
   * The article states no publication date, so `lastPublishedAt` is only when
   * Clarity indexed it — never show it as the time the news broke.
   */
  undated?: boolean;
  sourceCount: number;
  publisherDiversity: number;
  rankingScore: number;
  articles: NewsArticle[];
}

export interface NewsRequest {
  limit?: number;
  /** Primary language subtags, e.g. `es,en`. Empty means every language. */
  languages?: string[];
}

export interface NewsResponse {
  data: NewsStory[];
}
