// ---------------------------------------------------------------------------
// Common API envelope and pagination types shared by frontend and backend.
// ---------------------------------------------------------------------------

/**
 * Cursor-paginated list response (used by GET /conversations and similar).
 * The cursor is opaque to the client; pass it back as `cursor` to fetch the
 * next page.
 */
export interface CursorPaginated<T> {
  /** Items for the current page. */
  conversations: T[];
  /** Opaque cursor for the next page, or null when there are no more pages. */
  nextCursor: string | null;
  /** Whether another page is available. */
  hasMore: boolean;
}

/**
 * Generic offset/limit pagination metadata.
 */
export interface PaginationMeta {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Generic list response with offset/limit pagination metadata.
 */
export interface Paginated<T> {
  data: T[];
  pagination: PaginationMeta;
}

/**
 * Standard error response body returned by the API.
 *
 * MODEL ABSTRACTION RULE: `message` is user-facing and must already be
 * sanitized server-side (no internal provider names / provider model IDs).
 */
export interface ApiErrorResponse {
  error: string;
  message?: string;
  code?: string;
}
