import type {
  ProductAvailability,
  ProductDetail,
  ProductMoney,
  ProductOffer,
  ProductSummary,
} from '@clarity/shared-types';

import { publicApiStatus } from './api/public-api-error';

/**
 * What the Shopping surfaces show, decided in one place.
 *
 * Mercaria answered every product here, so these helpers only ever render what
 * it stated: an amount in its own currency (never converted), a missing price as
 * missing, Mercaria's order untouched. Locale and `now` are arguments so every
 * function is pure and testable without a renderer
 * (`lib/__tests__/products-format.test.ts`).
 */

/**
 * The minor-unit precision of a currency, from Intl's own ISO 4217 data (USD 2,
 * JPY 0, KWD 3). `null` for a code Intl cannot format — a price in a unit
 * nobody can read is not a price the page may state.
 */
export function currencyFractionDigits(currency: string): number | null {
  const code = currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  try {
    const digits = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: code,
    }).resolvedOptions().maximumFractionDigits;
    return typeof digits === 'number' ? digits : null;
  } catch {
    return null;
  }
}

/**
 * An amount in integer minor units, formatted in its OWN currency at that
 * currency's own precision. `null` when it cannot be stated honestly — a
 * non-integer amount or an unreadable currency — so the caller says "no price"
 * rather than guessing at a unit.
 */
export function formatProductMoney(money: ProductMoney, locale: string): string | null {
  if (!Number.isSafeInteger(money.amount)) return null;
  const digits = currencyFractionDigits(money.currency);
  if (digits === null) return null;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: money.currency.toUpperCase(),
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(money.amount / 10 ** digits);
}

/** What a result card says about price: three different answers, never conflated. */
export type SummaryPriceView =
  /** `offers` is null: nobody offers it right now. */
  | { state: 'no_offers' }
  /** Offered, but no offer states a price. */
  | { state: 'unpriced'; count: number }
  | { state: 'priced'; count: number; price: string };

export function summaryPriceView(summary: ProductSummary, locale: string): SummaryPriceView {
  const offers = summary.offers;
  if (!offers) return { state: 'no_offers' };
  const price = offers.lowestPrice ? formatProductMoney(offers.lowestPrice, locale) : null;
  if (price === null) return { state: 'unpriced', count: offers.count };
  return { state: 'priced', count: offers.count, price };
}

/**
 * What a card says about price for a product DETAIL (a `getProduct` result),
 * which differs from a summary in two ways that must not be flattened into it:
 * `offers: null` there means price comparison is temporarily unavailable — never
 * "nobody sells it" — and the offers may be priced in several currencies, which
 * have no lowest price without converting, so the card then states only how many.
 */
export type ProductCardPrice =
  | SummaryPriceView
  | { state: 'comparison_unavailable' }
  | { state: 'mixed_currencies'; count: number };

export function detailPriceView(detail: ProductDetail, locale: string): ProductCardPrice {
  const offers = detail.offers;
  if (offers === null) return { state: 'comparison_unavailable' };
  if (offers.length === 0) return { state: 'no_offers' };
  const priced = offers.flatMap((offer) => (offer.price ? [offer.price] : []));
  if (priced.length === 0) return { state: 'unpriced', count: offers.length };
  const currency = priced[0].currency.toUpperCase();
  if (priced.some((money) => money.currency.toUpperCase() !== currency))
    return { state: 'mixed_currencies', count: offers.length };
  // One currency: the lowest is a comparison of integers, nothing converted.
  const lowest = priced.reduce((min, money) => (money.amount < min.amount ? money : min));
  const price = formatProductMoney(lowest, locale);
  if (price === null) return { state: 'unpriced', count: offers.length };
  return { state: 'priced', count: offers.length, price };
}

/**
 * How long ago an offer was seen, e.g. "3 days ago". `null` when there is no
 * timestamp or it cannot be read; a timestamp ahead of `now` (clock skew) reads
 * as "now" rather than as a future sighting.
 */
export function formatObservedAt(value: string | null, locale: string, now: Date): string | null {
  if (!value) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  const seconds = Math.min(0, Math.round((at - now.getTime()) / 1000));
  const magnitude = -seconds;
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (magnitude < 60) return relative.format(0, 'second');
  if (magnitude < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (magnitude < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (magnitude < 30 * 86_400) return relative.format(Math.round(seconds / 86_400), 'day');
  if (magnitude < 365 * 86_400)
    return relative.format(Math.round(seconds / (30 * 86_400)), 'month');
  return relative.format(Math.round(seconds / (365 * 86_400)), 'year');
}

/** Who sells it: the stated name, and the merchant's domain when Mercaria knows it. */
export function sellerView(seller: ProductOffer['seller']): {
  name: string | null;
  domain: string | null;
} {
  switch (seller.kind) {
    case 'merchant':
      return { name: seller.name, domain: seller.domain };
    case 'store':
    case 'person':
      return { name: seller.name, domain: null };
    default:
      return { name: null, domain: null };
  }
}

/**
 * What following an offer does. A native offer is bought on Mercaria; any other
 * linked offer leaves for a retailer, so it carries the offer's `rel` and names
 * the host it goes to. An offer without a link has no action at all.
 */
export type OfferAction =
  | { kind: 'none' }
  | { kind: 'native'; href: string }
  | { kind: 'external'; href: string; rel: string | undefined; host: string | null };

export function offerAction(offer: ProductOffer): OfferAction {
  if (!offer.link) return { kind: 'none' };
  if (offer.kind === 'native') return { kind: 'native', href: offer.link };
  return {
    kind: 'external',
    href: offer.link,
    rel: offer.rel ?? undefined,
    host: offer.destinationHost,
  };
}

const AVAILABILITIES: readonly ProductAvailability[] = [
  'in_stock',
  'out_of_stock',
  'preorder',
  'unavailable',
  'unknown',
];

/** The i18n key for an availability; an unrecognised value reads as `unknown`. */
export function availabilityKey(availability: string): string {
  const known = (AVAILABILITIES as readonly string[]).includes(availability);
  return `shopping.availability.${known ? availability : 'unknown'}`;
}

const CONDITION_KEYS = [
  'new',
  'open_box',
  'refurbished_manufacturer',
  'refurbished_seller',
  'used_like_new',
  'used_good',
  'used_fair',
  'used_poor',
  'for_parts',
] as const;
const CONDITION_GROUPS = ['new', 'open_box', 'refurbished', 'used', 'for_parts'] as const;

/**
 * How to name an offer's condition: its exact key when Clarity has a label for
 * it, else its group, else the raw key as Mercaria sent it. `null` when the
 * condition was not stated — which is not the same as "new".
 */
export function conditionLabel(
  condition: ProductOffer['condition'],
): { i18nKey: string } | { raw: string } | null {
  if (!condition || condition.key === 'unknown') return null;
  if ((CONDITION_KEYS as readonly string[]).includes(condition.key))
    return { i18nKey: `shopping.condition.${condition.key}` };
  if ((CONDITION_GROUPS as readonly string[]).includes(condition.group))
    return { i18nKey: `shopping.conditionGroup.${condition.group}` };
  return { raw: condition.key.replace(/_/g, ' ') };
}

/** What a failed product request means to the person reading the page. */
export type ProductErrorKind = 'gone' | 'not_found' | 'unavailable' | 'rate_limited' | 'other';

export function productErrorKind(error: unknown): ProductErrorKind {
  switch (publicApiStatus(error)) {
    case 410:
      return 'gone';
    case 404:
      return 'not_found';
    case 503:
      return 'unavailable';
    case 429:
      return 'rate_limited';
    default:
      return 'other';
  }
}

/**
 * React Query's retry policy for product requests: a 4xx is an answer, not an
 * outage, so it is shown at once; only a network failure or a 5xx is retried.
 */
export function shouldRetryProductRequest(failureCount: number, error: unknown): boolean {
  const status = publicApiStatus(error);
  if (status !== undefined && status < 500) return false;
  return failureCount < 2;
}
