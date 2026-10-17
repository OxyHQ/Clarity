// ---------------------------------------------------------------------------
// Clarity products — shopping search, answered by Mercaria.
//
// Mercaria owns the catalogue: canonical products, every seller's offer (its
// own stores and people, and the retailers and open-data sources it ingests),
// matching and prices. Clarity reads it through `@mercaria.co/sdk` at query
// time and keeps no copy, so `source` is not decoration: it says whose answer
// this is, and a surface must show it.
//
// ORDER IS MERCARIA'S. Results arrive in Mercaria's relevance order and offers
// in Mercaria's ranked order; Clarity re-ranks neither, and no commercial
// signal of Clarity's (plans, payments, engagement) reaches either.
//
// PRICES ARE NATIVE. Every amount is integer minor units in the offer's own
// currency, converted by nobody; `null` when it cannot be stated.
// ---------------------------------------------------------------------------

/** Who answered: always Mercaria today. Show it beside the results. */
export interface ProductSource {
  name: 'Mercaria';
  url: string;
}

/** A price: integer minor units in its own currency. */
export interface ProductMoney {
  amount: number;
  currency: string;
}

/** Whether an offer can be had now. `unknown` is a real answer. */
export type ProductAvailability =
  | 'in_stock'
  | 'out_of_stock'
  | 'preorder'
  | 'unavailable'
  | 'unknown';

/** What an offer is: sold on Mercaria, a retailer's page, a tracked one, or a seen price. */
export type ProductOfferKind = 'native' | 'external' | 'affiliate' | 'informational';

/** A product as a result card renders it. */
export interface ProductSummary {
  /** Mercaria's catalog product id — what `GET /products/:id` takes. */
  id: string;
  name: string;
  imageUrl: string | null;
  /** The product's comparison page on mercaria.co. */
  url: string;
  /** `null` when nobody offers it right now: still a real answer, with no price. */
  offers: {
    count: number;
    availability: ProductAvailability;
    lowestPrice: ProductMoney | null;
  } | null;
}

export interface ProductSearchResponse {
  results: ProductSummary[];
  /** Pass back verbatim, with the same query, for the next page; `null` on the last. */
  nextCursor: string | null;
  source: ProductSource;
}

/** One way to get the product. */
export interface ProductOffer {
  id: string;
  kind: ProductOfferKind;
  /** The configuration this offer prices — one of the product's `variants`. */
  variantId: string;
  seller:
    | { kind: 'merchant'; name: string; domain: string | null }
    | { kind: 'store'; name: string }
    | { kind: 'person'; name: string }
    | { kind: 'unknown' };
  price: ProductMoney | null;
  availability: ProductAvailability;
  condition: { key: string; group: string } | null;
  observedAt: string | null;
  /**
   * Where following it goes: Mercaria's redirect for a retailer's offer (which
   * re-checks it at click time), its Mercaria page for a native one, or `null`.
   * Publish an external link with `rel` and name `destinationHost` beside it.
   */
  link: string | null;
  rel: string | null;
  destinationHost: string | null;
  /** Open-data attribution its licence requires. Show it when present. */
  attribution: { name: string; homepage: string; licence: string } | null;
}

export interface ProductDetail {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  images: string[];
  url: string;
  variants: { id: string; name: string | null; gtins: string[] }[];
  /** Ranked by Mercaria. `null` while Mercaria is not serving price comparison — never "nobody sells it". */
  offers: ProductOffer[] | null;
  source: ProductSource;
}
