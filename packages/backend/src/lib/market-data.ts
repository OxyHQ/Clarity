/**
 * Market quotes for Clarity's Finance surface.
 *
 * Two upstreams, both PUBLIC and KEYLESS, so no provider credential exists to
 * hold here and none of the credential-custody rules in AGENTS.md are engaged:
 *
 *  - CoinGecko, for anything that trades on an exchange.
 *  - The FairCoin explorer, for FAIR, which has no exchange listing at all. Its
 *    price is GeckoTerminal's INDEXED price for the WFAIR/USDC pool on Base
 *    (WFAIR is the 1:1 wrapped bridge token). The explorer deliberately does
 *    not read the pool's on-chain spot, because a tick on a low-liquidity pool
 *    can be moved inside a single block and is not a safe oracle. Clarity
 *    consumes that decision instead of re-deriving it, and carries `source` and
 *    `updatedAt` through to the caller: a price from a thin pool has to say
 *    where it came from and how old it is.
 *
 * EQUITIES ARE NOT SERVED HERE. Clarity's Finance page mocks AAPL, the S&P 500
 * and sector aggregates; every one of those needs a licensed equity feed, which
 * is a different provider under a different contract. Nothing in this module
 * half-serves them: `CLARITY_MARKET_CAPABILITY` says so in machine-readable
 * form, and asking for a ticker no cryptocurrency answers to fails with
 * `asset_not_found` rather than returning whatever CoinGecko's search ranked
 * first.
 *
 * Two history requests, not eight. The card offers 1D…MAX, and asking CoinGecko
 * once per range would spend eight calls of a free-tier minute on one question.
 * This fetches the intraday series and the full daily history and slices every
 * other range out of the daily one, so everything the card can show travels
 * with the quote: changing range costs nothing, and a cached or stored answer
 * shows the price that was quoted rather than today's.
 *
 * Upstream field names were read from source — the FairCoin explorer's
 * `server/routes/price.ts` and `server/lib/price-service.ts`, and Alia's merged
 * CoinGecko tool — not from a live response.
 */

import { z } from 'zod';

import { log } from './logger.js';
import { getRedisClient, withRedisTimeout } from './redis.js';

const COINGECKO_API = 'https://api.coingecko.com/api/v3';
const FAIRCOIN_EXPLORER_API = 'https://explorer.fairco.in/api';

const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * How long a composed quote is served from cache. Long enough that a page read
 * by a thousand people costs one upstream call a minute; short enough that the
 * number on the screen is never stale by more than a minute, which `updatedAt`
 * states outright.
 */
const QUOTE_TTL_SECONDS = 60;

/** Daily points kept per crypto range; `max` keeps the coin's whole history. */
const CRYPTO_RANGE_DAYS: Readonly<Record<string, number | 'max'>> = Object.freeze({
  '5D': 5, '1M': 30, '6M': 180, '1Y': 365, '5Y': 1825, MAX: 'max',
});

/**
 * Exactly the windows the FairCoin explorer retains, and no more. The crypto
 * two-request trick does not transfer: the explorer thins every window to 300
 * points, so slicing 24h out of `all` would yield about one point rather than a
 * day of five-minute samples. Each window is therefore its own request, and the
 * cache — not a slicing trick — is what keeps that off the explorer.
 */
const FAIRCOIN_PERIODS = ['24h', '7d', '30d', '1y', 'all'] as const;

/** Names that mean FairCoin. CoinGecko also lists a stale, delisted "faircoin"; the explorer is the only source Clarity quotes for FAIR. */
const FAIRCOIN_ALIASES: ReadonlySet<string> = new Set(['fair', 'faircoin', 'wfair']);

const FAIRCOIN_CURRENCY = 'usd';

/** `[msSinceEpoch, price]`, oldest first. */
export type MarketSeriesPoint = [number, number];

export interface MarketQuote {
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
  series: Record<string, MarketSeriesPoint[]>;
}

export class MarketDataError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'MarketDataError';
  }
}

/**
 * Where composed quotes are kept between readers.
 *
 * Backed by the Redis client this service already runs for rate limiting and
 * the Socket.IO adapter. It has to be shared rather than process-local: the API
 * runs as several ECS tasks behind one load balancer, so a module-level Map
 * would multiply every upstream call by the task count, lose the whole cache on
 * each deploy, and let CoinGecko's free-tier limit be reached by a page nobody
 * new is reading. No table is added for the same reason a table would be wrong:
 * this is somebody else's data with a one-minute life, not Clarity product
 * state.
 */
export interface MarketQuoteCache {
  read(key: string): Promise<string | null>;
  write(key: string, value: string, ttlSeconds: number): Promise<void>;
}

function redisQuoteCache(): MarketQuoteCache | null {
  const redis = getRedisClient();
  if (!redis) return null;
  return {
    read: (key) => withRedisTimeout(redis.get(key)),
    write: async (key, value, ttlSeconds) => {
      await withRedisTimeout(redis.set(key, value, 'EX', ttlSeconds));
    },
  };
}

export interface MarketQuoteOptions {
  /** ISO quote currency. CoinGecko quotes many; the FairCoin explorer quotes USD only. */
  currency?: string;
  fetch?: typeof fetch;
  /** Omit for the shared Redis cache; pass `null` to bypass caching entirely. */
  cache?: MarketQuoteCache | null;
  now?: Date;
}

/**
 * Requests in flight in THIS process, so a burst of readers arriving on a cold
 * cache collapses into one upstream call instead of one per reader. The Redis
 * entry covers everyone who arrives after the first answer lands; this covers
 * everyone who arrives before it.
 */
const inFlight = new Map<string, Promise<MarketQuote>>();

export async function getMarketQuote(asset: string, options: MarketQuoteOptions = {}): Promise<MarketQuote> {
  const wanted = asset.trim().toLowerCase();
  if (!wanted) throw new MarketDataError(400, 'invalid_request', 'An asset is required');
  const currency = (options.currency ?? 'usd').trim().toLowerCase();
  const cache = options.cache === undefined ? redisQuoteCache() : options.cache;
  const key = `market:quote:v1:${wanted}:${currency}`;

  const cached = await readCache(cache, key);
  if (cached) return cached;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = composeQuote(asset.trim(), wanted, currency, options)
    .then(async (quote) => {
      await writeCache(cache, key, quote);
      return quote;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

function composeQuote(asset: string, wanted: string, currency: string, options: MarketQuoteOptions): Promise<MarketQuote> {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? new Date();
  return FAIRCOIN_ALIASES.has(wanted)
    ? fairCoinQuote(currency, doFetch)
    : cryptoQuote(asset, currency, doFetch, now);
}

async function readCache(cache: MarketQuoteCache | null, key: string): Promise<MarketQuote | undefined> {
  if (!cache) return undefined;
  try {
    const raw = await cache.read(key);
    return raw ? (JSON.parse(raw) as MarketQuote) : undefined;
  } catch (error) {
    log.general.warn({ err: error, key }, 'Market quote cache read failed; falling through to the upstream');
    return undefined;
  }
}

async function writeCache(cache: MarketQuoteCache | null, key: string, quote: MarketQuote): Promise<void> {
  if (!cache) return;
  try {
    await cache.write(key, JSON.stringify(quote), QUOTE_TTL_SECONDS);
  } catch (error) {
    log.general.warn({ err: error, key }, 'Market quote cache write failed');
  }
}

async function fetchJson<T>(url: string, schema: z.ZodType<T>, doFetch: typeof fetch): Promise<T> {
  let payload: unknown;
  try {
    const response = await doFetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!response.ok) {
      throw new MarketDataError(503, 'upstream_unavailable', `The market data upstream answered ${response.status}`);
    }
    payload = await response.json();
  } catch (error) {
    if (error instanceof MarketDataError) throw error;
    log.general.warn({ err: error, url }, 'Market data upstream request failed');
    throw new MarketDataError(503, 'upstream_unavailable', 'The market data upstream is unreachable');
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    log.general.warn({ url, issues: parsed.error.issues }, 'Market data upstream returned an unreadable payload');
    throw new MarketDataError(503, 'upstream_unavailable', 'The market data upstream returned an unreadable payload');
  }
  return parsed.data;
}

/**
 * A field CoinGecko may add, rename or drop without telling anyone. Reading it
 * defensively keeps a renamed volume field from 503-ing an otherwise good
 * price; the price itself is required, because a quote without one is not a
 * quote.
 */
function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const coinSearchSchema = z.object({
  coins: z.array(z.object({ id: z.string(), name: z.string(), symbol: z.string() })),
});

/**
 * `[[msSinceEpoch, price], …]`. Read as a bounded array rather than a tuple so
 * an extra column upstream does not break the read. The `prices` key itself is
 * required: a 200 without it is a malfunction, not an empty history, and the
 * difference decides whether a caller sees an outage or a flat chart.
 */
const chartSchema = z.object({ prices: z.array(z.array(z.number()).min(2)) });

const simplePriceSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

/**
 * Resolve by an EXACT id, symbol or name, never by search rank. Taking the
 * first hit is what turns "AAPL" into whichever memecoin happens to mention
 * Apple; an exact match either finds the asset the caller named or says it is
 * not quoted here.
 */
async function resolveCoin(asset: string, doFetch: typeof fetch): Promise<{ id: string; name: string; symbol: string }> {
  const body = await fetchJson(`${COINGECKO_API}/search?query=${encodeURIComponent(asset)}`, coinSearchSchema, doFetch);
  const wanted = asset.toLowerCase();
  const match = body.coins.find((coin) => coin.id.toLowerCase() === wanted)
    ?? body.coins.find((coin) => coin.symbol.toLowerCase() === wanted)
    ?? body.coins.find((coin) => coin.name.toLowerCase() === wanted);
  if (!match) {
    throw new MarketDataError(404, 'asset_not_found', `No cryptocurrency is quoted as "${asset}". Equities, indices, ETFs and sector aggregates are not served by this API.`);
  }
  return match;
}

function seriesPoints(prices: number[][]): MarketSeriesPoint[] {
  return prices.map((point) => [point[0], point[1]] as MarketSeriesPoint);
}

async function cryptoQuote(asset: string, currency: string, doFetch: typeof fetch, now: Date): Promise<MarketQuote> {
  const coin = await resolveCoin(asset, doFetch);
  const id = encodeURIComponent(coin.id);
  const vs = encodeURIComponent(currency);
  const [intraday, history, simple] = await Promise.all([
    fetchJson(`${COINGECKO_API}/coins/${id}/market_chart?vs_currency=${vs}&days=1`, chartSchema, doFetch),
    fetchJson(`${COINGECKO_API}/coins/${id}/market_chart?vs_currency=${vs}&days=max&interval=daily`, chartSchema, doFetch),
    fetchJson(`${COINGECKO_API}/simple/price?ids=${id}&vs_currencies=${vs}&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`, simplePriceSchema, doFetch),
  ]);

  const daily = seriesPoints(history.prices);
  const series: Record<string, MarketSeriesPoint[]> = { '1D': seriesPoints(intraday.prices) };
  for (const [label, days] of Object.entries(CRYPTO_RANGE_DAYS)) {
    series[label] = days === 'max' ? daily : daily.slice(-days);
  }
  // Year to date is a DATE, not a count of days. Slicing 365 points off the end
  // would report last autumn as part of this year every day but one.
  const startOfYear = Date.UTC(now.getUTCFullYear(), 0, 1);
  series.YTD = daily.filter(([at]) => at >= startOfYear);

  const values = simple[coin.id] ?? {};
  const price = numeric(values[currency]);
  if (price === null) {
    throw new MarketDataError(503, 'upstream_unavailable', `The market data upstream returned no ${currency.toUpperCase()} price for ${coin.name}`);
  }
  const changePct = numeric(values[`${currency}_24h_change`]);

  return {
    asset: coin.id,
    name: coin.name,
    symbol: coin.symbol.toUpperCase(),
    currency,
    price,
    changePct,
    // Derivable, but every client would derive it and one would round it differently.
    changeAbs: changePct !== null && changePct > -100 ? price - price / (1 + changePct / 100) : null,
    marketCap: numeric(values[`${currency}_market_cap`]),
    volume24h: numeric(values[`${currency}_24h_vol`]),
    liquidityUsd: null,
    source: 'coingecko',
    // CoinGecko's quote carries no verified timestamp field, so this is when
    // Clarity read it — which is also what the cached copy has to report.
    updatedAt: now.toISOString(),
    series,
  };
}

const fairCoinPriceSchema = z.object({
  price: z.number().nullable(),
  change24h: z.number().nullable().optional(),
  volume24h: z.number().nullable().optional(),
  liquidityUsd: z.number().nullable().optional(),
  marketCapUsd: z.number().nullable().optional(),
  // Required. A pool-indexed price without its provenance is the one thing this
  // must never ship, so an explorer that stopped sending them is an outage.
  source: z.string().min(1),
  updatedAt: z.string().min(1),
});

const fairCoinHistorySchema = z.object({
  history: z.array(z.object({ price_usd: z.number(), timestamp: z.string() })),
});

async function fairCoinQuote(currency: string, doFetch: typeof fetch): Promise<MarketQuote> {
  if (currency !== FAIRCOIN_CURRENCY) {
    throw new MarketDataError(400, 'currency_unsupported', `FairCoin is quoted in ${FAIRCOIN_CURRENCY.toUpperCase()} only; the explorer publishes no other currency`);
  }
  const [quote, ...windows] = await Promise.all([
    fetchJson(`${FAIRCOIN_EXPLORER_API}/price`, fairCoinPriceSchema, doFetch),
    ...FAIRCOIN_PERIODS.map((period) => fetchJson(`${FAIRCOIN_EXPLORER_API}/price/history?period=${period}`, fairCoinHistorySchema, doFetch)
      .then((body) => body.history)
      // One unavailable window leaves that range out rather than failing a good
      // price. `series` names what it actually carries, so nothing is implied.
      .catch((error: unknown) => {
        log.general.warn({ err: error, period }, 'FairCoin price history window unavailable');
        return null;
      })),
  ]);

  const series: Record<string, MarketSeriesPoint[]> = {};
  for (const [index, period] of FAIRCOIN_PERIODS.entries()) {
    const points = windows[index];
    if (!points) continue;
    series[period] = points
      .map((point) => [Date.parse(point.timestamp), point.price_usd] as MarketSeriesPoint)
      .filter(([at]) => Number.isFinite(at));
  }

  const price = quote.price;
  const changePct = quote.change24h ?? null;
  return {
    asset: 'faircoin',
    name: 'FairCoin',
    symbol: 'FAIR',
    currency: FAIRCOIN_CURRENCY,
    // The explorer answers 200 with a null price when every source is down, and
    // that is a state the card renders, not an error to raise.
    price,
    changePct,
    changeAbs: price !== null && changePct !== null && changePct > -100 ? price - price / (1 + changePct / 100) : null,
    marketCap: quote.marketCapUsd ?? null,
    volume24h: quote.volume24h ?? null,
    liquidityUsd: quote.liquidityUsd ?? null,
    source: quote.source,
    updatedAt: quote.updatedAt,
    series,
  };
}

/**
 * What this surface can and cannot answer, for a consumer that has to decide
 * before asking — Clarity's Finance page, and Alia's tool layer once it stops
 * calling CoinGecko itself.
 */
export const CLARITY_MARKET_CAPABILITY = {
  name: 'clarity_market_quote',
  description:
    'Quote a cryptocurrency, with the full set of chart ranges in one answer. Returns the price, the 24h change, market cap, 24h volume, the source that produced the number and when it produced it.',
  endpoint: { method: 'GET', path: '/v1/market/quote/:asset', scope: 'clarity:market' },
  assets: {
    crypto: {
      source: 'coingecko',
      resolution: 'Exact CoinGecko id, symbol or name, case-insensitive. Search rank is never used, so an unmatched name is an error rather than the nearest coin.',
      currencies: 'Any ISO currency CoinGecko quotes; defaults to usd.',
      ranges: ['1D', ...Object.keys(CRYPTO_RANGE_DAYS), 'YTD'],
    },
    faircoin: {
      source: 'wfair-base',
      aliases: [...FAIRCOIN_ALIASES],
      currencies: [FAIRCOIN_CURRENCY],
      ranges: [...FAIRCOIN_PERIODS],
      grounding: 'The indexed price of the WFAIR/USDC pool on Base, as published by the FairCoin explorer — not the pool spot, which a single block can move. Always show `source` and `updatedAt` beside the number.',
    },
  },
  unsupported: {
    equities:
      'Stocks, indices, ETFs, futures and sector aggregates are not served. They need a licensed equity feed, which is a different provider under a different contract; asking for one returns asset_not_found rather than a guess.',
  },
  freshness: { cacheSeconds: QUOTE_TTL_SECONDS, updatedAtMeaning: 'When the source produced the number, not when Clarity served it.' },
} as const;
