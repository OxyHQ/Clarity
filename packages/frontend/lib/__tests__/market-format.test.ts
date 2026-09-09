import type { MarketQuoteResult, MarketQuoteSummary } from '@clarity/shared-types';
import { describe, expect, it } from 'vitest';

import { formatPrice, marketCardView } from '../market-format';

/**
 * What a Finance market card is allowed to show.
 *
 * Two of these are the whole point of the surface: a card must never print a
 * number it did not receive, and a price below a cent is still a price.
 */

const NOW = new Date('2026-09-09T12:00:00.000Z');

const summary = (overrides: Partial<MarketQuoteSummary> = {}): MarketQuoteSummary => ({
  asset: 'faircoin',
  name: 'FairCoin',
  symbol: 'FAIR',
  currency: 'usd',
  price: 0.0234,
  changePct: 2.5,
  changeAbs: 0.00057,
  marketCap: null,
  volume24h: null,
  liquidityUsd: 41_230.5,
  source: 'wfair-base',
  updatedAt: '2026-09-09T11:58:00.000Z',
  ...overrides,
});

const quoted = (overrides: Partial<MarketQuoteSummary> = {}): MarketQuoteResult => ({
  requested: 'faircoin',
  status: 'quoted',
  quote: summary(overrides),
});

const view = (result: MarketQuoteResult | undefined, state: { isPending?: boolean; isError?: boolean } = {}) =>
  marketCardView({
    result,
    isPending: state.isPending ?? false,
    isError: state.isError ?? false,
    locale: 'en-US',
    now: NOW,
  });

describe('a card that has no quote', () => {
  it('says it is loading while the request is in flight', () => {
    expect(view(undefined, { isPending: true })).toEqual({ state: 'loading' });
  });

  it('renders an error with NO number in it when the request failed', () => {
    expect(view(undefined, { isError: true })).toEqual({ state: 'error' });
  });

  it('renders an error with NO number in it when this one asset failed', () => {
    const unavailable: MarketQuoteResult = {
      requested: 'faircoin',
      status: 'unavailable',
      error: { code: 'upstream_unavailable', message: 'The market data upstream is unreachable' },
    };
    expect(view(unavailable)).toEqual({ state: 'error' });
  });

  it('renders an error rather than a stale card when the asset is missing from the answer', () => {
    expect(view(undefined)).toEqual({ state: 'error' });
  });

  it('tells loading and failure apart', () => {
    expect(view(undefined, { isPending: true })).not.toEqual(view(undefined, { isError: true }));
  });
});

describe('provenance', () => {
  it('carries the source and the age of every quoted price', () => {
    const card = view(quoted());
    if (card.state !== 'quoted') throw new Error('expected a quote');
    expect(card.source).toBe('wfair-base');
    expect(card.updatedAt).toBe('2 minutes ago');
  });

  it('carries them even when the source reports no usable price', () => {
    const card = view(quoted({ price: null, changePct: null }));
    expect(card).toEqual({
      state: 'unpriced',
      name: 'FairCoin',
      symbol: 'FAIR',
      source: 'wfair-base',
      updatedAt: '2 minutes ago',
    });
  });

  it('prints an unreadable timestamp verbatim rather than dropping it', () => {
    const card = view(quoted({ updatedAt: 'whenever' }));
    if (card.state !== 'quoted') throw new Error('expected a quote');
    expect(card.updatedAt).toBe('whenever');
  });
});

describe('prices', () => {
  it('shows a sub-cent price instead of rounding it to zero', () => {
    const card = view(quoted({ price: 0.0234 }));
    if (card.state !== 'quoted') throw new Error('expected a quote');
    expect(card.price).toBe('$0.0234');
  });

  it('keeps four significant figures however small the price gets', () => {
    expect(formatPrice(0.00012345, 'usd', 'en-US')).toBe('$0.0001235');
    expect(formatPrice(0.0000009876, 'usd', 'en-US')).toBe('$0.0000009876');
    expect(formatPrice(0.5, 'usd', 'en-US')).toBe('$0.50');
  });

  it('still shows two decimals for a price above a dollar', () => {
    expect(formatPrice(78_420.5, 'usd', 'en-US')).toBe('$78,420.50');
  });

  it('hands an unfamiliar but well-formed code to Intl, which prints it', () => {
    // Intl separates an unknown currency code from the number with U+00A0.
    expect(formatPrice(1.5, 'xbt', 'en-US')).toBe('XBT\u00a01.50');
  });

  it('names a currency Intl cannot format rather than throwing', () => {
    expect(formatPrice(1.5, 'not-a-currency', 'en-US')).toBe('1.50 NOT-A-CURRENCY');
  });
});

describe('the 24h change', () => {
  it('signs a rise and points it up', () => {
    const card = view(quoted({ changePct: 2.5 }));
    if (card.state !== 'quoted') throw new Error('expected a quote');
    expect(card).toMatchObject({ changePct: '+2.50%', direction: 'up' });
  });

  it('signs a fall and points it down', () => {
    const card = view(quoted({ changePct: -0.7 }));
    if (card.state !== 'quoted') throw new Error('expected a quote');
    expect(card).toMatchObject({ changePct: '-0.70%', direction: 'down' });
  });

  it('shows no change at all rather than an invented zero', () => {
    const card = view(quoted({ changePct: null }));
    if (card.state !== 'quoted') throw new Error('expected a quote');
    expect(card).toMatchObject({ changePct: null, direction: 'flat' });
  });
});
