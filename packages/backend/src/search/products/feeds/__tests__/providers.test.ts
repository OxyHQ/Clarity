import { describe, expect, it } from 'vitest';

import {
  ProductFeedSourceError,
  SHOPIFY_PAGE_SIZE,
  shopifyStorefront,
  STEAM_MAX_RESULTS,
  steamStore,
} from '../providers.js';

describe('shopify_storefront', () => {
  it('reads a domain in one spelling, whatever was typed', () => {
    expect(shopifyStorefront.canonicalIdentifier(' HTTPS://Shop.Example/collections/all ')).toBe(
      'shop.example',
    );
    expect(shopifyStorefront.canonicalIdentifier('not a domain')).toBeUndefined();
  });

  it('keeps every product object exactly as served, keyed by its id', () => {
    const product = { id: 7, title: 'Tee', handle: 'tee', variants: [{ id: 70, price: '19.99' }] };
    const page = shopifyStorefront.parsePage(
      JSON.stringify({ products: [product, 'junk', { id: 'x' }] }),
      undefined,
    );
    expect(page.documents).toEqual([{ externalId: '7', payload: product }]);
    // A short page is the last one.
    expect(page.nextCursor).toBeUndefined();
  });

  it('asks for the next page while pages are full', () => {
    const products = Array.from({ length: SHOPIFY_PAGE_SIZE }, (_, index) => ({ id: index + 1 }));
    expect(shopifyStorefront.parsePage(JSON.stringify({ products }), '3').nextCursor).toBe('4');
    expect(shopifyStorefront.pageRequest('shop.example', '4').url).toBe(
      'https://shop.example/products.json?limit=250&page=4',
    );
  });

  it('refuses a store whose meta names no currency', () => {
    expect(
      shopifyStorefront.parseMeta(
        'shop.example',
        JSON.stringify({ name: 'Shop', currency: 'EUR' }),
      ),
    ).toEqual({
      name: 'Shop',
      currency: 'EUR',
    });
    expect(() =>
      shopifyStorefront.parseMeta('shop.example', JSON.stringify({ name: 'x' })),
    ).toThrow(ProductFeedSourceError);
  });
});

describe('steam_store', () => {
  const row = (appId: string | null) =>
    `<a href="https://store.steampowered.com/app/${appId ?? 'b'}/x/?snr=1" ${
      appId ? `data-ds-appid="${appId}"` : 'data-ds-bundleid="9"'
    } class="search_result_row ds_collapse_flag"><span class="title">Game ${appId}</span></a>`;

  it('keeps each game row as rendered, keyed by app id, and skips bundles', () => {
    const body = JSON.stringify({
      results_html: `${row('10')}${row(null)}${row('20')}`,
      total_count: 3,
    });
    const page = steamStore.parsePage(body, undefined);
    expect(page.documents.map((document) => document.externalId)).toEqual(['10', '20']);
    expect(page.documents[0]?.payload).toEqual({
      html: expect.stringContaining('data-ds-appid="10"'),
    });
    expect(page.nextCursor).toBeUndefined();
  });

  it('walks Steam relevance order no deeper than its bound', () => {
    const rows = Array.from({ length: 100 }, (_, index) => row(String(index + 1))).join('');
    expect(
      steamStore.parsePage(JSON.stringify({ results_html: rows, total_count: 50_000 }), '0')
        .nextCursor,
    ).toBe('100');
    expect(
      steamStore.parsePage(
        JSON.stringify({ results_html: rows, total_count: 50_000 }),
        String(STEAM_MAX_RESULTS - 100),
      ).nextCursor,
    ).toBeUndefined();
  });

  it('names a market by country and derives its terms', () => {
    expect(steamStore.canonicalIdentifier('es')).toBe('ES');
    expect(steamStore.canonicalIdentifier('XX')).toBeUndefined();
    expect(steamStore.parseMeta('ES', null)).toEqual({
      country: 'ES',
      currency: 'EUR',
      language: 'spanish',
    });
    expect(steamStore.pageRequest('ES', '200').url).toContain('start=200');
  });
});
