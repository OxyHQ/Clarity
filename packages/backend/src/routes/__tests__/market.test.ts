import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { MarketQuotesResponse } from '@clarity/shared-types';

/**
 * The PUBLIC `/market` boundary, driven over real HTTP.
 *
 * The one thing a test cannot exercise offline is the sliding-window limiter,
 * which counts in Redis — and which fails OPEN when Redis is absent, so an
 * unmocked run would report every request allowed and prove nothing about the
 * guard. It is therefore a spy this test drives in both directions. Everything
 * after it is the real code: the real query validation, the real `sendError`
 * envelope, and the real market module reading a stubbed upstream.
 *
 * There is no outbound network here. `fetch` is stubbed for the whole file, so
 * a request that escaped the stub would fail rather than reach CoinGecko.
 */

const checkLimit = vi.fn(async () => ({ allowed: true }) as { allowed: boolean; resetInSeconds?: number });

vi.mock('../../lib/sliding-window-limiter.js', () => ({ checkLimit }));

const { default: marketRouter } = await import('../market.js');

const CLARITY_READ_AT = '2026-09-09T12:00:00.000Z';
const EXPLORER_PUBLISHED_AT = '2026-09-09T11:57:30.000Z';

/** Far below a cent, which is where FAIR actually trades. */
const FAIR_PRICE = 0.0234;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/**
 * Both upstreams. CoinGecko answers for bitcoin; the FairCoin explorer answers
 * for FAIR, with its OWN `source` and `updatedAt` — the two fields the card
 * has to show beside a pool-indexed price.
 */
const upstreams: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes('/search?')) return json({ coins: [{ id: 'bitcoin', name: 'Bitcoin', symbol: 'btc' }] });
  if (url.includes('market_chart')) return json({ prices: [[Date.parse(CLARITY_READ_AT), 78_420]] });
  if (url.includes('/simple/price')) return json({ bitcoin: { usd: 78_420, usd_24h_change: -0.7, usd_market_cap: 1_540_000_000_000 } });
  if (url.includes('/price/history')) return json({ history: [{ price_usd: FAIR_PRICE, timestamp: EXPLORER_PUBLISHED_AT }] });
  if (url.includes('/price')) {
    return json({
      price: FAIR_PRICE,
      change24h: 2.5,
      liquidityUsd: 41_230.5,
      source: 'wfair-base',
      updatedAt: EXPLORER_PUBLISHED_AT,
    });
  }
  return new Response(null, { status: 502 });
};
const upstream = vi.fn<typeof fetch>(upstreams);

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  // No REDIS_URL means no quote cache, so every case reaches the stubbed upstream.
  delete process.env.REDIS_URL;
  vi.stubGlobal('fetch', upstream);
  const app = express();
  app.use('/market', marketRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/market`;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  upstream.mockReset();
  upstream.mockImplementation(upstreams);
  checkLimit.mockReset();
  checkLimit.mockResolvedValue({ allowed: true });
});

/** `fetch` is stubbed with the upstream mock, so the test client needs the real one. */
const client = globalThis.fetch.bind(globalThis);
const get = (path: string, ip = '203.0.113.9') => client(`${baseUrl}${path}`, { headers: { 'x-forwarded-for': ip } });

describe('GET /market/quotes', () => {
  it('serves a quote with no credential at all', async () => {
    const response = await get('/quotes?assets=bitcoin');
    expect(response.status).toBe(200);
    const body = await response.json() as MarketQuotesResponse;
    expect(body.results).toEqual([{
      requested: 'bitcoin',
      status: 'quoted',
      quote: expect.objectContaining({
        asset: 'bitcoin', symbol: 'BTC', currency: 'usd', price: 78_420, source: 'coingecko',
      }),
    }]);
  });

  it('carries FairCoin OWN source and timestamp, not Clarity clock', async () => {
    const response = await get('/quotes?assets=fair');
    const body = await response.json() as MarketQuotesResponse;
    const [result] = body.results;
    expect(result.status).toBe('quoted');
    if (result.status !== 'quoted') return;
    expect(result.quote.source).toBe('wfair-base');
    expect(result.quote.updatedAt).toBe(EXPLORER_PUBLISHED_AT);
    expect(result.quote.updatedAt).not.toBe(CLARITY_READ_AT);
    expect(result.quote.liquidityUsd).toBe(41_230.5);
  });

  it('serves a sub-cent price at full precision, never rounded away', async () => {
    const response = await get('/quotes?assets=faircoin');
    const body = await response.json() as MarketQuotesResponse;
    const [result] = body.results;
    if (result.status !== 'quoted') throw new Error('expected a quote');
    expect(result.quote.price).toBe(FAIR_PRICE);
  });

  it('answers summaries, so a card does not pay for chart history it never draws', async () => {
    const response = await get('/quotes?assets=bitcoin');
    const body = await response.json() as MarketQuotesResponse;
    const [result] = body.results;
    if (result.status !== 'quoted') throw new Error('expected a quote');
    expect(result.quote).not.toHaveProperty('series');
  });

  it('reports one failing asset without taking the others off the page', async () => {
    upstream.mockImplementation(async (input) => {
      if (String(input).includes('explorer.fairco.in')) return new Response(null, { status: 502 });
      return upstreams(input);
    });
    const response = await get('/quotes?assets=bitcoin,faircoin');
    expect(response.status).toBe(200);
    const body = await response.json() as MarketQuotesResponse;
    expect(body.results.map((result) => [result.requested, result.status])).toEqual([
      ['bitcoin', 'quoted'],
      ['faircoin', 'unavailable'],
    ]);
    const failed = body.results[1];
    if (failed.status !== 'unavailable') throw new Error('expected a failure');
    expect(failed.error.code).toBe('upstream_unavailable');
  });

  it('names the asset that was asked for, so a caller can pair answers with its own list', async () => {
    upstream.mockImplementation(async (input) => (
      String(input).includes('/search?') ? json({ coins: [] }) : upstreams(input)
    ));
    const body = await (await get('/quotes?assets=AAPL')).json() as MarketQuotesResponse;
    expect(body.results[0].requested).toBe('AAPL');
    expect(body.results[0].status).toBe('unavailable');
    const [result] = body.results;
    if (result.status !== 'unavailable') throw new Error('expected a failure');
    expect(result.error.code).toBe('asset_not_found');
  });

  it('rejects an asset that is not a plain name, id or symbol', async () => {
    const response = await get(`/quotes?assets=${encodeURIComponent('https://evil.test/x')}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses to fan out beyond one page of cards', async () => {
    const response = await get('/quotes?assets=a1,a2,a3,a4,a5,a6,a7,a8,a9');
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects a currency that is not an ISO code', async () => {
    const response = await get('/quotes?assets=bitcoin&currency=not-a-currency');
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('the anonymous rate guard', () => {
  it('turns a caller away with 429 and retry-after, before any upstream call', async () => {
    checkLimit.mockResolvedValue({ allowed: false, resetInSeconds: 42 });
    const response = await get('/quotes?assets=bitcoin');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    expect(await response.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('guards the capability door too', async () => {
    checkLimit.mockResolvedValue({ allowed: false });
    expect((await get('/capability')).status).toBe(429);
  });

  it('counts per address and in its own bucket, so Jobs and Finance do not throttle each other', async () => {
    await get('/quotes?assets=bitcoin', '198.51.100.7');
    await get('/quotes?assets=bitcoin', '203.0.113.9');
    expect(checkLimit.mock.calls).toEqual([
      ['anon:market:198.51.100.7', 'free'],
      ['anon:market:203.0.113.9', 'free'],
    ]);
  });
});

describe('GET /market/capability', () => {
  it('is public, and refuses to imply equities', async () => {
    const response = await get('/capability');
    expect(response.status).toBe(200);
    const capability = await response.json();
    expect(capability.unsupported.equities).toContain('licensed equity feed');
    expect(capability.assets.faircoin.source).toBe('wfair-base');
  });
});
