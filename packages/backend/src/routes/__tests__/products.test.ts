import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ProductDetail, ProductSearchResponse } from '@clarity/shared-types';

/**
 * The PUBLIC `/products` boundary over real HTTP, with Mercaria stubbed at the
 * SDK's `fetch`.
 *
 * Everything between is the real code: the query validation, the real
 * `@mercaria.co/sdk` parsing Mercaria's contract bodies, the mapping into
 * Clarity's shapes and the refusal mapping. The stub answers with bodies that
 * pass Mercaria's own contract schemas, so a shape the SDK would refuse fails
 * here as it would in production.
 *
 * What matters most is ORDER: Clarity re-ranks neither results nor offers, so
 * the order Mercaria answered with is the order Clarity serves.
 */

const checkLimit = vi.fn(
  async () => ({ allowed: true }) as { allowed: boolean; resetInSeconds?: number },
);
vi.mock('../../lib/sliding-window-limiter.js', () => ({ checkLimit }));

const { default: productsRouter } = await import('../products.js');
const { setMercariaFetchForTests } = await import('../../search/products/mercaria-catalog.js');

const MERCARIA = 'https://api.mercaria.co/public/v1';

function summaryWire(id: string, name: string, lowest: number | null) {
  return {
    ref: { kind: 'catalog_product', id },
    name,
    image: { url: `https://media.test.invalid/${id}`, alt: null },
    url: `https://mercaria.co/p/${id}`,
    offers:
      lowest === null
        ? null
        : { count: 2, availability: 'in_stock', lowestPrice: { amount: lowest, currency: 'EUR' } },
  };
}

const PRODUCT = {
  ref: { kind: 'catalog_product', id: 'cp_phone' },
  name: 'Phone X',
  image: null,
  url: 'https://mercaria.co/p/phone-x',
  description: null,
  images: [],
  variants: [{ id: 'v_1', name: '128 GB', gtins: ['00012345678905'] }],
  offers: [
    {
      id: 'o_dear_native',
      kind: 'native',
      variantId: 'v_1',
      seller: {
        kind: 'store',
        store: { kind: 'store', id: 'store_1' },
        handle: 'shop-one',
        name: 'Shop One',
      },
      price: { amount: 52_000, currency: 'EUR' },
      availability: 'in_stock',
      condition: { key: 'new', group: 'new' },
      observedAt: '2026-09-01T10:00:00.000Z',
      action: {
        kind: 'mercaria_checkout',
        purchaseOption: { kind: 'variant', productId: 'listing_1', variantId: 'pv_1' },
        url: 'https://mercaria.co/products/listing_1',
      },
      source: null,
    },
    {
      id: 'o_cheap_external',
      kind: 'external',
      variantId: 'v_1',
      seller: { kind: 'merchant', name: 'Retailer', domain: 'shop.example' },
      price: { amount: 49_900, currency: 'EUR' },
      availability: 'unknown',
      condition: null,
      observedAt: null,
      action: {
        kind: 'outbound',
        path: '/out/mgo_abc.def',
        destinationHost: 'shop.example',
        rel: 'sponsored nofollow noopener',
      },
      source: {
        name: 'Open Prices',
        homepage: 'https://prices.openfoodfacts.org',
        licenceLabel: 'ODbL 1.0',
      },
    },
  ],
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let answer: (url: string) => Response = () => json(500, {});
const mercariaFetch = vi.fn(async (input: string) => answer(input));

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  setMercariaFetchForTests(mercariaFetch as never);
  const app = express();
  app.use('/products', productsRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/products`;
});

afterAll(async () => {
  setMercariaFetchForTests(undefined);
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  mercariaFetch.mockClear();
});

describe('GET /products/search', () => {
  it('answers in Mercaria’s order, says who answered, and forwards the query and market', async () => {
    answer = () =>
      json(200, {
        // Dearest first on purpose: Clarity must not sort by price.
        items: [
          summaryWire('cp_b', 'Phone B', 70_000),
          summaryWire('cp_a', 'Phone A', 10_000),
          summaryWire('cp_c', 'Phone C', null),
        ],
        nextCursor: 'next-page',
      });
    const response = await fetch(`${baseUrl}/search?q=%20phone%20&market=es&limit=3`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ProductSearchResponse;

    expect(body.results.map((result) => result.id)).toEqual(['cp_b', 'cp_a', 'cp_c']);
    expect(body.results[0]).toEqual({
      id: 'cp_b',
      name: 'Phone B',
      imageUrl: 'https://media.test.invalid/cp_b',
      url: 'https://mercaria.co/p/cp_b',
      offers: {
        count: 2,
        availability: 'in_stock',
        lowestPrice: { amount: 70_000, currency: 'EUR' },
      },
    });
    expect(body.results[2]?.offers).toBeNull();
    expect(body.nextCursor).toBe('next-page');
    expect(body.source).toEqual({ name: 'Mercaria', url: 'https://mercaria.co' });
    expect(mercariaFetch.mock.calls[0]?.[0]).toBe(
      `${MERCARIA}/catalog/products?limit=3&market=ES&q=phone`,
    );
  });

  it('refuses a missing query or a market that is not a country before asking Mercaria', async () => {
    for (const query of ['', '?q=%20%20', '?q=phone&market=spain', '?q=phone&limit=0']) {
      const response = await fetch(`${baseUrl}/search${query}`);
      expect(response.status, query).toBe(400);
    }
    expect(mercariaFetch).not.toHaveBeenCalled();
  });

  it('is 503 when Mercaria cannot answer — never an empty page', async () => {
    answer = () => json(503, { error: { code: 'service_unavailable', message: 'off' } });
    const response = await fetch(`${baseUrl}/search?q=phone`);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'products_unavailable',
    );
  });
});

describe('GET /products/:id', () => {
  it('serves every offer in Mercaria’s ranked order, with absolute links and attribution', async () => {
    answer = () => json(200, PRODUCT);
    const response = await fetch(`${baseUrl}/cp_phone`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ProductDetail;

    // The dearer native offer stays first: that is Mercaria's ranking, not Clarity's.
    expect(body.offers?.map((offer) => offer.id)).toEqual(['o_dear_native', 'o_cheap_external']);
    const [native, external] = body.offers ?? [];
    expect(native).toMatchObject({
      seller: { kind: 'store', name: 'Shop One' },
      link: 'https://mercaria.co/products/listing_1',
      rel: null,
      destinationHost: null,
      attribution: null,
    });
    expect(external).toMatchObject({
      seller: { kind: 'merchant', name: 'Retailer', domain: 'shop.example' },
      price: { amount: 49_900, currency: 'EUR' },
      link: 'https://api.mercaria.co/out/mgo_abc.def',
      rel: 'sponsored nofollow noopener',
      destinationHost: 'shop.example',
      attribution: {
        name: 'Open Prices',
        homepage: 'https://prices.openfoodfacts.org',
        licence: 'ODbL 1.0',
      },
    });
    expect(body.variants).toEqual([{ id: 'v_1', name: '128 GB', gtins: ['00012345678905'] }]);
    expect(body.source.name).toBe('Mercaria');
  });

  it('keeps Mercaria’s not found and gone apart, and refuses a malformed id itself', async () => {
    answer = () => json(404, { error: { code: 'not_found', message: 'nope' } });
    expect((await fetch(`${baseUrl}/cp_missing`)).status).toBe(404);
    answer = () => json(410, { error: { code: 'gone', message: 'gone' } });
    expect((await fetch(`${baseUrl}/cp_withdrawn`)).status).toBe(410);

    mercariaFetch.mockClear();
    expect((await fetch(`${baseUrl}/${encodeURIComponent('../etc')}`)).status).toBe(404);
    expect(mercariaFetch).not.toHaveBeenCalled();
  });
});
