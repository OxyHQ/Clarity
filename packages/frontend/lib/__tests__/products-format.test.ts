import type { ProductDetail, ProductOffer, ProductSummary } from '@clarity/shared-types';
import { describe, expect, it } from 'vitest';

import { PublicApiError } from '../api/public-api-error';
import {
  availabilityKey,
  conditionLabel,
  currencyFractionDigits,
  detailPriceView,
  formatObservedAt,
  formatProductMoney,
  offerAction,
  productErrorKind,
  sellerView,
  shouldRetryProductRequest,
  summaryPriceView,
} from '../products-format';

/**
 * What the Shopping surfaces are allowed to show. The rules that matter: an
 * amount is minor units in its OWN currency at that currency's precision, never
 * converted; a missing price or a missing set of offers is said, not filled in.
 */

const NOW = new Date('2026-10-17T12:00:00.000Z');

const summary = (offers: ProductSummary['offers']): ProductSummary => ({
  id: 'p1',
  name: 'Kettle',
  imageUrl: null,
  url: 'https://mercaria.co/p/p1',
  offers,
});

const offer = (overrides: Partial<ProductOffer> = {}): ProductOffer => ({
  id: 'o1',
  kind: 'external',
  variantId: 'v1',
  seller: { kind: 'merchant', name: 'Shop', domain: 'shop.example' },
  price: { amount: 1999, currency: 'EUR' },
  availability: 'in_stock',
  condition: null,
  observedAt: null,
  link: 'https://mercaria.co/r/o1',
  rel: 'sponsored nofollow',
  destinationHost: 'shop.example',
  attribution: null,
  ...overrides,
});

const detail = (offers: ProductOffer[] | null): ProductDetail => ({
  id: 'p1',
  name: 'Kettle',
  description: null,
  imageUrl: null,
  images: [],
  url: 'https://mercaria.co/p/p1',
  variants: [{ id: 'v1', name: null, gtins: [] }],
  offers,
  source: { name: 'Mercaria', url: 'https://mercaria.co' },
});

describe('money', () => {
  it("formats minor units at the currency's own precision", () => {
    expect(formatProductMoney({ amount: 1999, currency: 'USD' }, 'en-US')).toBe('$19.99');
    expect(formatProductMoney({ amount: 1999, currency: 'JPY' }, 'en-US')).toBe('¥1,999');
    expect(formatProductMoney({ amount: 1999, currency: 'KWD' }, 'en-US')).toBe('KWD\u00a01.999');
  });

  it('keeps trailing zeros a price states', () => {
    expect(formatProductMoney({ amount: 500, currency: 'eur' }, 'en-US')).toBe('€5.00');
  });

  it('never converts: the currency printed is the currency given', () => {
    expect(formatProductMoney({ amount: 1000, currency: 'GBP' }, 'en-GB')).toBe('£10.00');
    expect(formatProductMoney({ amount: 1000, currency: 'MXN' }, 'es-MX')).toBe('$10.00');
  });

  it('refuses to state an amount it cannot read', () => {
    expect(formatProductMoney({ amount: 19.5, currency: 'USD' }, 'en-US')).toBeNull();
    expect(formatProductMoney({ amount: 100, currency: 'not-a-code' }, 'en-US')).toBeNull();
    expect(currencyFractionDigits('??')).toBeNull();
  });
});

describe('a result card price', () => {
  it('says there are no current offers when offers is null', () => {
    expect(summaryPriceView(summary(null), 'en-US')).toEqual({ state: 'no_offers' });
  });

  it('says there is no price when no offer states one', () => {
    expect(
      summaryPriceView(summary({ count: 3, availability: 'in_stock', lowestPrice: null }), 'en-US'),
    ).toEqual({ state: 'unpriced', count: 3 });
  });

  it('shows the lowest price and the offer count', () => {
    expect(
      summaryPriceView(
        summary({
          count: 2,
          availability: 'in_stock',
          lowestPrice: { amount: 4250, currency: 'EUR' },
        }),
        'en-US',
      ),
    ).toEqual({ state: 'priced', count: 2, price: '€42.50' });
  });
});

describe('a product detail drawn as a card', () => {
  it('never reads unavailable comparison as nobody selling it', () => {
    expect(detailPriceView(detail(null), 'en-US')).toEqual({ state: 'comparison_unavailable' });
    expect(detailPriceView(detail([]), 'en-US')).toEqual({ state: 'no_offers' });
  });

  it('finds the lowest price within one currency', () => {
    const offers = [
      offer({ price: { amount: 2500, currency: 'EUR' } }),
      offer({ id: 'o2', price: { amount: 1999, currency: 'EUR' } }),
      offer({ id: 'o3', price: null }),
    ];
    expect(detailPriceView(detail(offers), 'en-US')).toEqual({
      state: 'priced',
      count: 3,
      price: '€19.99',
    });
  });

  it('states no lowest price across currencies, which would need a conversion', () => {
    const offers = [
      offer({ price: { amount: 2500, currency: 'EUR' } }),
      offer({ id: 'o2', price: { amount: 1999, currency: 'USD' } }),
    ];
    expect(detailPriceView(detail(offers), 'en-US')).toEqual({
      state: 'mixed_currencies',
      count: 2,
    });
  });
});

describe('an offer', () => {
  it('leaves for a retailer with its rel and destination host', () => {
    expect(offerAction(offer())).toEqual({
      kind: 'external',
      href: 'https://mercaria.co/r/o1',
      rel: 'sponsored nofollow',
      host: 'shop.example',
    });
  });

  it('is bought on Mercaria when native', () => {
    expect(offerAction(offer({ kind: 'native', link: 'https://mercaria.co/p/p1' }))).toEqual({
      kind: 'native',
      href: 'https://mercaria.co/p/p1',
    });
  });

  it('has no action without a link', () => {
    expect(offerAction(offer({ link: null }))).toEqual({ kind: 'none' });
  });

  it('names the seller, with the merchant domain when known', () => {
    expect(sellerView({ kind: 'merchant', name: 'Shop', domain: 'shop.example' })).toEqual({
      name: 'Shop',
      domain: 'shop.example',
    });
    expect(sellerView({ kind: 'person', name: 'Ana' })).toEqual({ name: 'Ana', domain: null });
    expect(sellerView({ kind: 'unknown' })).toEqual({ name: null, domain: null });
  });

  it('labels a condition by key, then by group, else verbatim — and an absent one not at all', () => {
    expect(conditionLabel({ key: 'used_good', group: 'used' })).toEqual({
      i18nKey: 'shopping.condition.used_good',
    });
    expect(conditionLabel({ key: 'used_mint', group: 'used' })).toEqual({
      i18nKey: 'shopping.conditionGroup.used',
    });
    expect(conditionLabel({ key: 'salvage_title', group: 'other' })).toEqual({
      raw: 'salvage title',
    });
    expect(conditionLabel(null)).toBeNull();
    expect(conditionLabel({ key: 'unknown', group: 'unknown' })).toBeNull();
  });

  it('reads an unrecognised availability as unknown', () => {
    expect(availabilityKey('in_stock')).toBe('shopping.availability.in_stock');
    expect(availabilityKey('sold_by_tuesday')).toBe('shopping.availability.unknown');
  });
});

describe('when an offer was seen', () => {
  it('reads as a relative time', () => {
    expect(formatObservedAt('2026-10-14T12:00:00.000Z', 'en-US', NOW)).toBe('3 days ago');
    expect(formatObservedAt('2026-10-17T09:00:00.000Z', 'en-US', NOW)).toBe('3 hours ago');
    expect(formatObservedAt('2026-07-17T12:00:00.000Z', 'en-US', NOW)).toBe('3 months ago');
  });

  it('reads a future timestamp as now, and a missing or unreadable one as nothing', () => {
    expect(formatObservedAt('2026-10-18T12:00:00.000Z', 'en-US', NOW)).toBe('now');
    expect(formatObservedAt(null, 'en-US', NOW)).toBeNull();
    expect(formatObservedAt('whenever', 'en-US', NOW)).toBeNull();
  });
});

describe('a failed request', () => {
  it('tells gone, not found and unavailable apart', () => {
    expect(productErrorKind(new PublicApiError({ status: 410, code: 'gone' }))).toBe('gone');
    expect(productErrorKind(new PublicApiError({ status: 404 }))).toBe('not_found');
    expect(productErrorKind(new PublicApiError({ status: 503 }))).toBe('unavailable');
    expect(productErrorKind(new PublicApiError({ status: 429 }))).toBe('rate_limited');
    expect(productErrorKind(new TypeError('Network request failed'))).toBe('other');
  });

  it('retries an outage but not an answer', () => {
    expect(shouldRetryProductRequest(0, new PublicApiError({ status: 410 }))).toBe(false);
    expect(shouldRetryProductRequest(0, new PublicApiError({ status: 404 }))).toBe(false);
    expect(shouldRetryProductRequest(0, new PublicApiError({ status: 503 }))).toBe(true);
    expect(shouldRetryProductRequest(0, new TypeError('offline'))).toBe(true);
    expect(shouldRetryProductRequest(2, new PublicApiError({ status: 503 }))).toBe(false);
  });
});
