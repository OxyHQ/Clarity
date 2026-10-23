import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { restoreFetch, stubFetch } from '../../../__tests__/support/global-fetch.js';

import type { ClarityResourcePrincipal } from '../../../middleware/resource-auth.js';
import type { FetchFunction } from '../../../lib/fetch-function.js';

/**
 * The `/v1/market` boundary, driven over real HTTP.
 *
 * Oxy introspection and the per-credential rate ceiling are the two things a
 * test cannot exercise offline — the first calls Oxy, the second writes to
 * PostgreSQL — so both are replaced with a spy that records it ran and hands
 * over a principal this test controls. Everything after that is the real code:
 * the real `requireResourceScope`, the real `sendError` envelope, the real
 * market module reading a stubbed upstream.
 */

const rateLimit = vi.fn((_req: Request, _res: Response, next: NextFunction) => next());
let principal: ClarityResourcePrincipal;

type ResourceAuth = typeof import('../../../middleware/resource-auth.js');
/*
 * This file runs under vitest AND under `bun test` (see the `test:bun` script).
 * bun:test hands the factory no `importOriginal`, and importing the module from
 * inside its own factory deadlocks there, so under Bun the real exports are
 * copied BEFORE the mock is registered. Under vitest `vi.mock` is hoisted above
 * this line, but its factory only runs at the dynamic import below, by which
 * point `bunActual` is initialised (to undefined).
 */
const bunActual: ResourceAuth | undefined =
  'Bun' in globalThis ? { ...(await import('../../../middleware/resource-auth.js')) } : undefined;

vi.mock(
  '../../../middleware/resource-auth.js',
  async (importOriginal?: () => Promise<ResourceAuth>) => {
    const actual = bunActual ?? (await importOriginal?.());
    if (!actual) throw new Error('no original resource-auth module to extend');
    return {
      ...actual,
      authenticateResource: (req: Request, _res: Response, next: NextFunction) => {
        req.resourcePrincipal = principal;
        next();
      },
      requireResourceRequestRate: (req: Request, res: Response, next: NextFunction) =>
        rateLimit(req, res, next),
    };
  },
);

const { default: marketRouter } = await import('../market.js');

const scoped = (scopes: string[]): ClarityResourcePrincipal => ({
  active: true,
  permissions: [],
  kind: 'service',
  accountId: 'account-1',
  applicationId: 'application-1',
  authority: 'external',
  credentialId: 'credential-1',
  environment: 'development',
  audience: 'oxy-api',
  expiresAt: '2099-01-01T00:00:00.000Z',
  scopes,
});

const NOW_ISO = '2026-09-09T12:00:00.000Z';
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const coinGecko: FetchFunction = async (input) => {
  const url = String(input);
  if (url.includes('/search?'))
    return json({ coins: [{ id: 'bitcoin', name: 'Bitcoin', symbol: 'btc' }] });
  if (url.includes('market_chart')) return json({ prices: [[Date.parse(NOW_ISO), 78_420]] });
  if (url.includes('/simple/price'))
    return json({ bitcoin: { usd: 78_420, usd_24h_change: -0.7 } });
  return new Response(null, { status: 502 });
};
const upstream = vi.fn<FetchFunction>(coinGecko);

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  // No REDIS_URL means no cache, so every case reaches the stubbed upstream.
  delete process.env.REDIS_URL;
  stubFetch(upstream);
  const app = express();
  app.use('/v1/market', marketRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/market`;
});

afterAll(async () => {
  restoreFetch();
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  upstream.mockReset();
  upstream.mockImplementation(coinGecko);
  rateLimit.mockClear();
});

/** `fetch` is stubbed with the upstream mock, so the test client needs the real one. */
const client = globalThis.fetch.bind(globalThis);
const get = (path: string) => client(`${baseUrl}${path}`);

describe('GET /v1/market/quote/:asset', () => {
  it('serves a quote to a credential that holds clarity:market', async () => {
    principal = scoped(['clarity:market']);
    const response = await get('/quote/bitcoin');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      asset: 'bitcoin',
      symbol: 'BTC',
      currency: 'usd',
      price: 78_420,
      source: 'coingecko',
    });
    expect(rateLimit).toHaveBeenCalledOnce();
  });

  it('refuses a credential that only holds the search platform scopes', async () => {
    principal = scoped(['clarity:search', 'clarity:index', 'clarity:sites:manage']);
    const response = await get('/quote/bitcoin');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'scope_missing' } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects an asset that is not a plain name, id or symbol', async () => {
    principal = scoped(['clarity:market']);
    const response = await get(`/quote/${encodeURIComponent('https://evil.test/x')}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects a currency that is not an ISO code', async () => {
    principal = scoped(['clarity:market']);
    const response = await get('/quote/bitcoin?currency=not-a-currency');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('answers 404 for a ticker no cryptocurrency answers to', async () => {
    principal = scoped(['clarity:market']);
    upstream.mockImplementationOnce(async () => json({ coins: [] }));
    const response = await get('/quote/AAPL');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'asset_not_found' } });
  });

  it('answers 503 rather than a fabricated quote when the upstream is down', async () => {
    principal = scoped(['clarity:market']);
    upstream.mockImplementation(async () => new Response(null, { status: 502 }));
    const response = await get('/quote/bitcoin');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'upstream_unavailable' } });
  });
});

describe('GET /v1/market/capability', () => {
  it('publishes the scope it is behind and refuses to imply equities', async () => {
    principal = scoped(['clarity:market']);
    const response = await get('/capability');
    expect(response.status).toBe(200);
    const capability = await response.json();
    expect(capability.endpoint).toEqual({
      method: 'GET',
      path: '/v1/market/quote/:asset',
      scope: 'clarity:market',
    });
    expect(capability.unsupported.equities).toContain('licensed equity feed');
    expect(capability.assets.faircoin.source).toBe('wfair-base');
  });

  it('is behind the same scope as the quote', async () => {
    principal = scoped(['clarity:search']);
    expect((await get('/capability')).status).toBe(403);
  });
});
