import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { oxyTrustProxy } from '@oxy.so/core/server';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { restoreFetch, stubFetch } from '../../__tests__/support/global-fetch.js';

import type { MarketQuotesResponse } from '@clarity/shared-types';
import type { FetchFunction } from '../../lib/fetch-function.js';

/**
 * The PUBLIC `/market` boundary, driven over real HTTP.
 *
 * Everything is the real code: the real rate limiter (Oxy's, counting in
 * memory here because there is no REDIS_URL), the real query validation, the
 * real `sendError` envelope, and the real market module reading a stubbed
 * upstream. Each request comes from its own address unless a case says
 * otherwise, so only the rate-limit cases ever fill a bucket.
 *
 * There is no outbound network here. `fetch` is stubbed for the whole file, so
 * a request that escaped the stub would fail rather than reach CoinGecko.
 */

const { default: marketRouter } = await import('../market.js');

const CLARITY_READ_AT = '2026-09-09T12:00:00.000Z';
const EXPLORER_PUBLISHED_AT = '2026-09-09T11:57:30.000Z';

/** Far below a cent, which is where FAIR actually trades. */
const FAIR_PRICE = 0.0234;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Both upstreams. CoinGecko answers for bitcoin; the FairCoin explorer answers
 * for FAIR, with its OWN `source` and `updatedAt` — the two fields the card
 * has to show beside a pool-indexed price.
 */
const upstreams: FetchFunction = async (input) => {
  const url = String(input);
  if (url.includes('/search?'))
    return json({ coins: [{ id: 'bitcoin', name: 'Bitcoin', symbol: 'btc' }] });
  if (url.includes('market_chart'))
    return json({ prices: [[Date.parse(CLARITY_READ_AT), 78_420]] });
  if (url.includes('/simple/price'))
    return json({
      bitcoin: { usd: 78_420, usd_24h_change: -0.7, usd_market_cap: 1_540_000_000_000 },
    });
  if (url.includes('/price/history'))
    return json({ history: [{ price_usd: FAIR_PRICE, timestamp: EXPLORER_PUBLISHED_AT }] });
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
const upstream = vi.fn<FetchFunction>(upstreams);

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  // No REDIS_URL means no quote cache, so every case reaches the stubbed upstream.
  delete process.env.REDIS_URL;
  stubFetch(upstream);
  const app = express();
  // As `index.ts` sets it. The test client connects over loopback, which
  // stands in for the ALB (a private socket peer).
  app.set('trust proxy', oxyTrustProxy);
  app.use('/market', marketRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/market`;
});

afterAll(async () => {
  restoreFetch();
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  upstream.mockReset();
  upstream.mockImplementation(upstreams);
});

/** `fetch` is stubbed with the upstream mock, so the test client needs the real one. */
const client = globalThis.fetch.bind(globalThis);
let nextAddress = 0;
/** A caller of its own (192.0.2.0/24 is never one a rate-limit case uses), unless `ip` names one. */
const get = (path: string, ip = `192.0.2.${++nextAddress}`) =>
  client(`${baseUrl}${path}`, { headers: { 'x-forwarded-for': ip } });

describe('GET /market/quotes', () => {
  it('serves a quote with no credential at all', async () => {
    const response = await get('/quotes?assets=bitcoin');
    expect(response.status).toBe(200);
    const body = (await response.json()) as MarketQuotesResponse;
    expect(body.results).toEqual([
      {
        requested: 'bitcoin',
        status: 'quoted',
        quote: expect.objectContaining({
          asset: 'bitcoin',
          symbol: 'BTC',
          currency: 'usd',
          price: 78_420,
          source: 'coingecko',
        }),
      },
    ]);
  });

  it('carries FairCoin OWN source and timestamp, not Clarity clock', async () => {
    const response = await get('/quotes?assets=fair');
    const body = (await response.json()) as MarketQuotesResponse;
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
    const body = (await response.json()) as MarketQuotesResponse;
    const [result] = body.results;
    if (result.status !== 'quoted') throw new Error('expected a quote');
    expect(result.quote.price).toBe(FAIR_PRICE);
  });

  it('answers summaries, so a card does not pay for chart history it never draws', async () => {
    const response = await get('/quotes?assets=bitcoin');
    const body = (await response.json()) as MarketQuotesResponse;
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
    const body = (await response.json()) as MarketQuotesResponse;
    expect(body.results.map((result) => [result.requested, result.status])).toEqual([
      ['bitcoin', 'quoted'],
      ['faircoin', 'unavailable'],
    ]);
    const failed = body.results[1];
    if (failed.status !== 'unavailable') throw new Error('expected a failure');
    expect(failed.error.code).toBe('upstream_unavailable');
  });

  it('names the asset that was asked for, so a caller can pair answers with its own list', async () => {
    upstream.mockImplementation(async (input) =>
      String(input).includes('/search?') ? json({ coins: [] }) : upstreams(input),
    );
    const body = (await (await get('/quotes?assets=AAPL')).json()) as MarketQuotesResponse;
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

describe('the rate guard', () => {
  /** The anonymous budget per address per minute (`middleware/rate-limit.ts`). */
  const BUDGET = 20;

  /** Spend `address`'s whole budget, each request as `forwardedFor(i)`. */
  async function exhaust(forwardedFor: (i: number) => string) {
    for (let i = 0; i < BUDGET; i += 1) {
      expect((await get('/capability', forwardedFor(i))).status).toBe(200);
    }
  }

  it('turns a caller away with 429, retry-after and the error envelope, before any upstream call', async () => {
    await exhaust(() => '198.51.100.10');
    upstream.mockClear();
    const response = await get('/quotes?assets=bitcoin', '198.51.100.10');
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({
      error: { code: 'rate_limited', details: { retryAfterSeconds: expect.any(Number) } },
    });
    expect(upstream).not.toHaveBeenCalled();
    // Another caller is untouched.
    expect((await get('/quotes?assets=bitcoin', '198.51.100.11')).status).toBe(200);
  });

  it('keys the real client, not the Cloudflare edge, on a proxied hostname', async () => {
    // Grey (DNS-only) and orange (proxied) requests from one client share one bucket.
    await exhaust((i) => (i % 2 ? '198.51.100.20' : '198.51.100.20, 172.70.1.2'));
    expect((await get('/capability', '198.51.100.20, 2606:4700:10::ac43:1')).status).toBe(429);
    // Two callers through the same edge are two buckets, not one.
    expect((await get('/capability', '198.51.100.21, 172.70.1.2')).status).toBe(200);
  });

  it('never believes an address the caller wrote into X-Forwarded-For itself', async () => {
    await exhaust(() => '198.51.100.30');
    // Grey: the ALB appended the caller's own address after the forgery.
    expect((await get('/capability', '192.0.2.250, 198.51.100.30')).status).toBe(429);
    // Orange: Cloudflare appended the caller, the ALB appended Cloudflare.
    expect((await get('/capability', '192.0.2.251, 198.51.100.30, 172.70.1.2')).status).toBe(429);
    // A forged Cloudflare address one hop too far out vouches for nothing.
    expect((await get('/capability', '192.0.2.252, 172.70.1.2, 198.51.100.30')).status).toBe(429);
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
