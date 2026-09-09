import type { MarketQuoteResult } from '@clarity/shared-types';

/**
 * What a Finance market card shows, decided in one place.
 *
 * The card renders this and nothing else, which is what makes "we could not get
 * this" impossible to confuse with a price: the `error` variant carries no
 * number at all, so there is no field a fallback could be written into. The
 * same reason `source` and `updatedAt` are required on every variant that has
 * a quote — FairCoin's price is an indexed reading of a thin liquidity pool,
 * and a card that shows the number without saying where and when it came from
 * is the failure the whole feature exists to avoid.
 *
 * Locale and `now` are arguments rather than module state so the derivation is
 * pure and can be tested without a renderer. See `lib/__tests__/market-format.test.ts`.
 */
export type MarketCardView =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'unpriced'; name: string; symbol: string; source: string; updatedAt: string }
  | {
      state: 'quoted';
      name: string;
      symbol: string;
      price: string;
      changePct: string | null;
      direction: 'up' | 'down' | 'flat';
      source: string;
      updatedAt: string;
    };

export interface MarketCardInput {
  result: MarketQuoteResult | undefined;
  isPending: boolean;
  isError: boolean;
  locale: string;
  now: Date;
}

/**
 * How many decimals a price needs to still be a price.
 *
 * FAIR trades far below a dollar, so the two decimals that suit a $78,420
 * bitcoin would render it as $0.00 — a number that is not merely imprecise but
 * false. Below a dollar the count grows with the magnitude so that four
 * significant figures survive.
 */
function fractionDigits(price: number): number {
  const magnitude = Math.abs(price);
  if (magnitude >= 1 || magnitude === 0) return 2;
  return Math.min(12, Math.max(2, 3 - Math.floor(Math.log10(magnitude))));
}

export function formatPrice(price: number, currency: string, locale: string): string {
  const maximumFractionDigits = fractionDigits(price);
  const code = currency.toUpperCase();
  // Intl throws on anything that is not an ISO code, and a thrown formatter
  // takes the whole page down. Anything unexpected is printed beside the number.
  if (!/^[A-Z]{3}$/.test(code)) {
    return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits }).format(price)} ${code}`;
  }
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: code,
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(price);
}

export function formatChangePct(changePct: number, locale: string): string {
  const formatted = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(changePct);
  return `${changePct > 0 ? '+' : ''}${formatted}%`;
}

/**
 * When the SOURCE produced the number, relative to now. An unparseable
 * timestamp is printed verbatim rather than dropped: a quote that cannot say
 * how old it is still has to say what it claimed.
 */
export function formatUpdatedAt(value: string, locale: string, now: Date): string {
  const at = Date.parse(value);
  if (Number.isNaN(at)) return value;
  const seconds = Math.round((at - now.getTime()) / 1000);
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const magnitude = Math.abs(seconds);
  if (magnitude < 60) return relative.format(Math.min(seconds, 0), 'second');
  if (magnitude < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (magnitude < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  return relative.format(Math.round(seconds / 86_400), 'day');
}

export function marketCardView(input: MarketCardInput): MarketCardView {
  if (input.isPending) return { state: 'loading' };
  if (input.isError || !input.result || input.result.status === 'unavailable') return { state: 'error' };

  const { quote } = input.result;
  const source = quote.source;
  const updatedAt = formatUpdatedAt(quote.updatedAt, input.locale, input.now);
  if (quote.price === null) {
    return { state: 'unpriced', name: quote.name, symbol: quote.symbol, source, updatedAt };
  }
  return {
    state: 'quoted',
    name: quote.name,
    symbol: quote.symbol,
    price: formatPrice(quote.price, quote.currency, input.locale),
    changePct: quote.changePct === null ? null : formatChangePct(quote.changePct, input.locale),
    direction: quote.changePct === null || quote.changePct === 0 ? 'flat' : quote.changePct > 0 ? 'up' : 'down',
    source,
    updatedAt,
  };
}
