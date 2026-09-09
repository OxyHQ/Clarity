// ---------------------------------------------------------------------------
// Clarity market quotes — the price data behind the Finance surface.
//
// A quote is somebody else's number, so `source` and `updatedAt` are not
// optional decoration: they say who produced it and when. FairCoin's price in
// particular is an INDEXED reading of a thin liquidity pool rather than an
// exchange print, and a card that shows the number without saying so is the
// failure this shape exists to prevent. Both fields are therefore required on
// every quote and travel all the way to the client.
//
// Equities, indices, ETFs and sector aggregates are NOT quoted. See
// packages/backend/src/lib/market-data.ts for why, and what happens instead.
// ---------------------------------------------------------------------------

/** `[msSinceEpoch, price]`, oldest first. */
export type MarketSeriesPoint = [number, number];

/**
 * One asset's price, without history.
 *
 * This is what a card needs. It is a separate type from `MarketQuote` rather
 * than an optional `series` field so that a consumer can never confuse "this
 * door does not serve history" with "this asset has no history".
 */
export interface MarketQuoteSummary {
  /** Canonical upstream id: a CoinGecko coin id, or `faircoin`. */
  asset: string;
  name: string;
  symbol: string;
  currency: string;
  /** `null` only when the source itself reports it has no usable price. */
  price: number | null;
  changePct: number | null;
  changeAbs: number | null;
  marketCap: number | null;
  volume24h: number | null;
  /** Pool liquidity. Only a pool-priced asset has one; `null` everywhere else. */
  liquidityUsd: number | null;
  /** Where the number came from, verbatim from the source that produced it. */
  source: string;
  /** When the source produced it, not when Clarity served it. */
  updatedAt: string;
}

/** A quote plus every chart range the source can answer, keyed by range label. */
export interface MarketQuote extends MarketQuoteSummary {
  series: Record<string, MarketSeriesPoint[]>;
}

/** Why one asset in a batch has no quote. Codes come from the market module. */
export interface MarketQuoteError {
  code: string;
  message: string;
}

/**
 * One requested asset's outcome, carrying the string the caller asked for so
 * answers pair with the caller's own list. One asset failing never removes it
 * from the response: a card that asked for FairCoin gets FairCoin's error, not
 * a shorter list it has to reason about.
 */
export type MarketQuoteResult =
  | { requested: string; status: 'quoted'; quote: MarketQuoteSummary }
  | { requested: string; status: 'unavailable'; error: MarketQuoteError };

/** `GET /market/quotes`. Always one result per requested asset, in order. */
export interface MarketQuotesResponse {
  results: MarketQuoteResult[];
}
