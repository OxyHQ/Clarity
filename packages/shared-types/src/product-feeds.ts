// ---------------------------------------------------------------------------
// Clarity product feeds — public shop catalogues Clarity crawls for products.
//
// Clarity is Oxy's ONE crawler of stores. It fetches each feed under robots.txt
// (ClarityBot), at a polite pace, and keeps the SOURCE DOCUMENTS exactly as the
// store served them. It does not interpret them commercially: Mercaria pulls
// them through `@clarity.surf/sdk` and reads them with its own mapping, so a
// product, its variants and its identity mean what Mercaria says they mean.
// ---------------------------------------------------------------------------

/**
 * - `shopify_storefront`: a Shopify store by domain. `meta` is its `/meta.json`;
 *   each record is one product object of `/products.json`, keyed by product id.
 * - `steam_store`: the Steam store's game search for one market (ISO country).
 *   `meta` is `{ country, currency, language }`; each record is `{ html }`, one
 *   search result row, keyed by app id, in Steam's relevance order.
 */
export type ProductFeedKind = 'shopify_storefront' | 'steam_store';

export interface ProductFeed {
  id: string;
  kind: ProductFeedKind;
  identifier: string;
  label: string | null;
  enabled: boolean;
  pollIntervalSeconds: number;
  lastPolledAt: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
  /** When a walk last reached the end. `null`: the records are not yet a whole catalogue. */
  lastCompletedAt: string | null;
  recordsSeen: number;
  meta: Record<string, unknown> | null;
}

export interface ProductFeedRegistration {
  kind: ProductFeedKind;
  identifier: string;
  label?: string;
}

export interface ProductFeedRecord {
  externalId: string;
  payload: unknown;
  /** When the payload last changed. */
  changedAt: string;
  /** When Clarity last saw it at the source. */
  lastSeenAt: string;
}

export interface ProductFeedRecordPage {
  feed: ProductFeed;
  records: ProductFeedRecord[];
  /** Pass back verbatim for the next page; `null` on the last. */
  nextCursor: string | null;
}
