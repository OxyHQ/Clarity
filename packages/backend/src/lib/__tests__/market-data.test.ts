import { describe, expect, it, vi } from 'vitest';

import {
  getMarketQuote, MarketDataError, type MarketQuoteCache,
} from '../market-data.js';

/**
 * What Clarity serves for a market quote.
 *
 * NOT verified against CoinGecko or the FairCoin explorer: `fetch` is injected
 * here, so these fix the transformation — the slicing, the YTD cut, the exact
 * resolution rule, the provenance that has to survive, the cache — and say
 * nothing about whether the upstream fields are still called this. One real
 * call is what settles that, and this environment has no outbound network.
 */

const NOW = new Date('2026-09-09T12:00:00.000Z');
const DAY = 86_400_000;

/** `days` daily points ending at NOW, priced 100, 101, 102 … */
const dailySeries = (days: number): number[][] =>
  Array.from({ length: days }, (_, index) => [NOW.getTime() - (days - 1 - index) * DAY, 100 + index]);

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const BITCOIN = { id: 'bitcoin', name: 'Bitcoin', symbol: 'btc', thumb: 'https://example.test/btc.png' };

/** A cache that is only ever this test's map, so nothing leaks between cases. */
function memoryCache(): MarketQuoteCache & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    read: async (key) => entries.get(key) ?? null,
    write: async (key, value) => { entries.set(key, value); },
  };
}

function coinGecko(options: { daily?: number[][]; coins?: unknown[]; price?: unknown; failing?: RegExp } = {}) {
  const daily = options.daily ?? dailySeries(800);
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (options.failing?.test(url)) return new Response(null, { status: 502 });
    if (url.includes('/search?')) return json({ coins: options.coins ?? [BITCOIN] });
    // Answers ANY range, the way CoinGecko would. A range fetched per-card-tab
    // therefore returns correct data, so the request COUNT is what has to catch
    // it rather than a fixture that happens not to know the URL.
    if (url.includes('market_chart')) {
      const days = new URL(url).searchParams.get('days');
      if (days === '1') return json({ prices: [[NOW.getTime() - 3_600_000, 79_000], [NOW.getTime(), 79_500]] });
      return json({ prices: days === 'max' ? daily : daily.slice(-Number(days)) });
    }
    if (url.includes('/simple/price')) {
      return json(options.price ?? {
        bitcoin: {
          usd: 78_420, usd_24h_change: -0.7, usd_24h_vol: 42, usd_market_cap: 1_500_000,
          eur: 72_100, eur_24h_change: -0.5, eur_24h_vol: 40, eur_market_cap: 1_400_000,
        },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

const chartCalls = (mock: ReturnType<typeof coinGecko>) =>
  mock.mock.calls.filter(([url]) => String(url).includes('market_chart'));

const crypto = (asset = 'bitcoin', fetchMock = coinGecko(), currency = 'usd') =>
  getMarketQuote(asset, { fetch: fetchMock, cache: null, now: NOW, currency });

describe('crypto quotes', () => {
  it('makes two history requests, not one per range', async () => {
    const fetchMock = coinGecko();
    await crypto('bitcoin', fetchMock);
    expect(chartCalls(fetchMock)).toHaveLength(2);
  });

  it('carries every range the card can offer', async () => {
    const quote = await crypto();
    expect(Object.keys(quote.series).sort()).toEqual(['1D', '1M', '1Y', '5D', '5Y', '6M', 'MAX', 'YTD']);
  });

  it('slices the shorter ranges out of the one daily history', async () => {
    const quote = await crypto();
    expect(quote.series['5D'].map(([, price]) => price)).toEqual([895, 896, 897, 898, 899]);
    expect(quote.series['1M']).toHaveLength(30);
    expect(quote.series['6M']).toHaveLength(180);
    expect(quote.series['1Y']).toHaveLength(365);
    // The coin is younger than five years, so 5Y and MAX are the whole history.
    expect(quote.series['5Y']).toHaveLength(800);
    expect(quote.series.MAX).toHaveLength(800);
    expect(quote.series['1D']).toHaveLength(2);
  });

  it('cuts YTD at the turn of the year rather than by a day count', async () => {
    const quote = await crypto();
    const startOfYear = Date.UTC(2026, 0, 1);
    // 1 January to 9 September 2026 inclusive. A 365-day slice would reach back
    // to September 2025 and report last autumn as part of this year.
    expect(quote.series.YTD).toHaveLength(252);
    expect(quote.series.YTD[0][0]).toBe(Date.UTC(2026, 0, 1, 12));
    expect(quote.series.YTD.every(([at]) => at >= startOfYear)).toBe(true);
  });

  it('reports the numbers the card renders, and where they came from', async () => {
    const quote = await crypto();
    expect(quote).toMatchObject({
      asset: 'bitcoin', name: 'Bitcoin', symbol: 'BTC', currency: 'usd',
      price: 78_420, changePct: -0.7, volume24h: 42, marketCap: 1_500_000,
      liquidityUsd: null, source: 'coingecko', updatedAt: NOW.toISOString(),
    });
    expect(quote.changeAbs).toBeCloseTo(78_420 - 78_420 / (1 - 0.007), 6);
  });

  it('quotes the currency that was asked for', async () => {
    const quote = await crypto('bitcoin', coinGecko(), 'eur');
    expect(quote).toMatchObject({ currency: 'eur', price: 72_100, changePct: -0.5, marketCap: 1_400_000 });
  });

  it('resolves by an exact id, symbol or name and never by search rank', async () => {
    const fetchMock = coinGecko({
      coins: [
        { id: 'wrapped-bitcoin', name: 'Wrapped Bitcoin', symbol: 'wbtc' },
        BITCOIN,
      ],
      price: { bitcoin: { usd: 78_420 } },
    });
    const quote = await crypto('BTC', fetchMock);
    expect(quote.asset).toBe('bitcoin');
  });

  it('refuses an equity ticker instead of returning the nearest coin', async () => {
    const fetchMock = coinGecko({ coins: [{ id: 'apple-fan-token', name: 'Apple Fan Token', symbol: 'aft' }] });
    await expect(crypto('AAPL', fetchMock)).rejects.toMatchObject({
      name: 'MarketDataError', status: 404, code: 'asset_not_found',
    });
    expect(chartCalls(fetchMock)).toHaveLength(0);
  });

  it('does not invent a quote when a history request fails', async () => {
    await expect(crypto('bitcoin', coinGecko({ failing: /days=max/ }))).rejects.toMatchObject({
      status: 503, code: 'upstream_unavailable',
    });
  });

  it('treats a 200 that carries no history as an outage, not a flat chart', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/search?')) return json({ coins: [BITCOIN] });
      if (url.includes('market_chart')) return json({ status: { error_code: 429 } });
      return json({ bitcoin: { usd: 78_420 } });
    });
    await expect(crypto('bitcoin', fetchMock)).rejects.toMatchObject({
      status: 503, code: 'upstream_unavailable',
    });
  });

  it('does not invent a quote when the upstream returns no price', async () => {
    await expect(crypto('bitcoin', coinGecko({ price: { bitcoin: {} } }))).rejects.toMatchObject({
      status: 503, code: 'upstream_unavailable',
    });
  });
});

const FAIRCOIN_PRICE = {
  price: 0.0412,
  change24h: 1.8,
  volume24h: 1_230.5,
  liquidityUsd: 48_900,
  marketCapUsd: 2_100_000,
  source: 'wfair-base',
  updatedAt: '2026-09-09T11:59:30.000Z',
};

function fairCoinExplorer(options: { price?: unknown; failing?: RegExp } = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (options.failing?.test(url)) return new Response(null, { status: 502 });
    if (url.includes('/price/history')) {
      const period = new URL(url).searchParams.get('period');
      return json({
        period,
        source: 'wfair-base',
        history: [{ price_usd: 0.04, timestamp: '2026-09-08T12:00:00.000Z' }, { price_usd: 0.0412, timestamp: '2026-09-09T12:00:00.000Z' }],
      });
    }
    if (url.endsWith('/price')) return json(options.price ?? FAIRCOIN_PRICE);
    throw new Error(`unexpected request: ${url}`);
  });
}

const faircoin = (fetchMock = fairCoinExplorer(), currency = 'usd') =>
  getMarketQuote('faircoin', { fetch: fetchMock, cache: null, now: NOW, currency });

describe('FairCoin quotes', () => {
  it('carries the explorer\'s own source and timestamp, not Clarity\'s', async () => {
    const quote = await faircoin();
    expect(quote).toMatchObject({
      asset: 'faircoin', name: 'FairCoin', symbol: 'FAIR', currency: 'usd',
      price: 0.0412, changePct: 1.8, volume24h: 1_230.5, liquidityUsd: 48_900, marketCap: 2_100_000,
      source: 'wfair-base', updatedAt: '2026-09-09T11:59:30.000Z',
    });
    expect(quote.updatedAt).not.toBe(NOW.toISOString());
  });

  it('asks for each window the explorer retains, and no others', async () => {
    const fetchMock = fairCoinExplorer();
    const quote = await faircoin(fetchMock);
    expect(Object.keys(quote.series)).toEqual(['24h', '7d', '30d', '1y', 'all']);
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('period')))
      .toEqual([null, '24h', '7d', '30d', '1y', 'all']);
    expect(quote.series['7d']).toEqual([
      [Date.parse('2026-09-08T12:00:00.000Z'), 0.04],
      [Date.parse('2026-09-09T12:00:00.000Z'), 0.0412],
    ]);
  });

  it('leaves out only the window the explorer could not serve', async () => {
    const quote = await faircoin(fairCoinExplorer({ failing: /period=30d/ }));
    expect(Object.keys(quote.series)).toEqual(['24h', '7d', '1y', 'all']);
    expect(quote.price).toBe(0.0412);
  });

  it('passes the explorer\'s own null price through rather than raising', async () => {
    const quote = await faircoin(fairCoinExplorer({
      price: { ...FAIRCOIN_PRICE, price: null, change24h: null },
    }));
    expect(quote.price).toBeNull();
    expect(quote.changeAbs).toBeNull();
    expect(quote.source).toBe('wfair-base');
  });

  it('fails rather than shipping a pool price with no provenance', async () => {
    const withoutSource: Record<string, unknown> = { ...FAIRCOIN_PRICE };
    delete withoutSource.source;
    await expect(faircoin(fairCoinExplorer({ price: withoutSource }))).rejects.toMatchObject({
      status: 503, code: 'upstream_unavailable',
    });
  });

  it('fails when the price request itself is down', async () => {
    await expect(faircoin(fairCoinExplorer({ failing: /\/price$/ }))).rejects.toMatchObject({
      status: 503, code: 'upstream_unavailable',
    });
  });

  it('refuses a currency the explorer does not publish, without calling it', async () => {
    const fetchMock = fairCoinExplorer();
    await expect(faircoin(fetchMock, 'eur')).rejects.toMatchObject({
      status: 400, code: 'currency_unsupported',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers to every alias FairCoin is asked for, and never to CoinGecko', async () => {
    for (const alias of ['FAIR', 'FairCoin', 'wfair']) {
      const fetchMock = fairCoinExplorer();
      const quote = await getMarketQuote(alias, { fetch: fetchMock, cache: null, now: NOW });
      expect(quote.source).toBe('wfair-base');
      expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith('https://explorer.fairco.in/'))).toBe(true);
    }
  });
});

describe('caching', () => {
  it('serves the next reader from the cache instead of the upstream', async () => {
    const cache = memoryCache();
    const fetchMock = coinGecko();
    const first = await getMarketQuote('bitcoin', { fetch: fetchMock, cache, now: NOW });
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBe(4);

    const second = await getMarketQuote('bitcoin', { fetch: fetchMock, cache, now: new Date(NOW.getTime() + 30_000) });
    expect(fetchMock.mock.calls).toHaveLength(callsAfterFirst);
    expect(second).toEqual(first);
    // The cached copy still reports when the number was READ, not when it was served.
    expect(second.updatedAt).toBe(NOW.toISOString());
  });

  it('collapses a cold-cache burst into one upstream round', async () => {
    const cache = memoryCache();
    const fetchMock = coinGecko();
    const quotes = await Promise.all([
      getMarketQuote('bitcoin', { fetch: fetchMock, cache, now: NOW }),
      getMarketQuote('bitcoin', { fetch: fetchMock, cache, now: NOW }),
      getMarketQuote('bitcoin', { fetch: fetchMock, cache, now: NOW }),
    ]);
    expect(fetchMock.mock.calls).toHaveLength(4);
    expect(quotes[1]).toEqual(quotes[0]);
    expect(quotes[2]).toEqual(quotes[0]);
  });

  it('keys the cache by asset and currency, so a euro reader is not served dollars', async () => {
    const cache = memoryCache();
    const fetchMock = coinGecko();
    await getMarketQuote('bitcoin', { fetch: fetchMock, cache, now: NOW, currency: 'usd' });
    const euros = await getMarketQuote('bitcoin', { fetch: fetchMock, cache, now: NOW, currency: 'eur' });
    expect(euros.price).toBe(72_100);
    expect(fetchMock.mock.calls).toHaveLength(8);
    expect([...cache.entries.keys()]).toEqual(['market:quote:v1:bitcoin:usd', 'market:quote:v1:bitcoin:eur']);
  });

  it('caches nothing when the upstream failed', async () => {
    const cache = memoryCache();
    await expect(getMarketQuote('bitcoin', { fetch: coinGecko({ failing: /days=max/ }), cache, now: NOW }))
      .rejects.toBeInstanceOf(MarketDataError);
    expect(cache.entries.size).toBe(0);

    const recovered = await getMarketQuote('bitcoin', { fetch: coinGecko(), cache, now: NOW });
    expect(recovered.price).toBe(78_420);
  });

  it('still answers when the cache backend is broken', async () => {
    const broken: MarketQuoteCache = {
      read: async () => { throw new Error('redis unavailable'); },
      write: async () => { throw new Error('redis unavailable'); },
    };
    const quote = await getMarketQuote('bitcoin', { fetch: coinGecko(), cache: broken, now: NOW });
    expect(quote.price).toBe(78_420);
  });
});
