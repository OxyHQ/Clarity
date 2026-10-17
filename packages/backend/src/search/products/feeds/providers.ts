/**
 * What each product feed kind fetches, and how a response splits into source
 * documents. PURE: no network, no database — `poll.ts` does the reading, under
 * robots.txt and a polite pace, and these functions only name the requests and
 * cut the bodies.
 *
 * Nothing here interprets a document commercially. A Shopify product object is
 * kept exactly as `/products.json` served it, a Steam search row exactly as the
 * store rendered it; what they MEAN (a variant's price, an app's market) is the
 * consumer's reading — Mercaria's, through `@clarity.surf/sdk`.
 */

import type { ProductFeedKind } from '@clarity/shared-types';

import type { JobFeedRequest } from '../../jobs/feeds/provider.js';

/** One source document a feed lists, keyed by the source's own id. */
export interface ProductFeedDocument {
  externalId: string;
  payload: unknown;
}

export interface ProductFeedPage {
  documents: ProductFeedDocument[];
  /** Where the next page starts, or undefined when the walk reached the end. */
  nextCursor?: string;
}

export interface ProductFeedProvider {
  kind: ProductFeedKind;
  /** What the identifier means, for errors and operators. */
  meaning: string;
  /** The identifier in its one canonical spelling, or undefined when it is not one. */
  canonicalIdentifier(raw: string): string | undefined;
  /** The feed-level document's request, or null when it is derived from the identifier. */
  metaRequest(identifier: string): JobFeedRequest | null;
  /** The feed-level document, from its response body (or from the identifier alone). */
  parseMeta(identifier: string, body: string | null): Record<string, unknown>;
  pageRequest(identifier: string, cursor: string | undefined): JobFeedRequest;
  parsePage(body: string, cursor: string | undefined): ProductFeedPage;
  /** The pause between two requests to the source, on top of its own Crawl-delay. */
  pauseMs: number;
  /** How many pages one poll reads before it hands the rest of the walk to the next. */
  pagesPerPoll: number;
}

export class ProductFeedSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductFeedSourceError';
  }
}

function json(body: string, what: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new ProductFeedSourceError(`${what} is not JSON`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── Shopify storefronts ─────────────────────────────────────────────────────

/** `/products.json` serves at most 250 a page. */
export const SHOPIFY_PAGE_SIZE = 250;

export const shopifyStorefront: ProductFeedProvider = {
  kind: 'shopify_storefront',
  meaning: 'the store domain (e.g. "pompeiibrand.com")',
  canonicalIdentifier(raw) {
    const domain = raw
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//u, '')
      .replace(/\/.*$/u, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/u.test(domain) ? domain : undefined;
  },
  metaRequest: (domain) => ({
    url: `https://${domain}/meta.json`,
    method: 'GET',
    accept: 'application/json',
  }),
  parseMeta(domain, body) {
    const meta = json(body ?? '', `https://${domain}/meta.json`);
    if (!isObject(meta) || typeof meta.currency !== 'string' || !/^[A-Z]{3}$/u.test(meta.currency))
      throw new ProductFeedSourceError(
        `https://${domain}/meta.json names no currency; is this a Shopify store?`,
      );
    return meta;
  },
  pageRequest: (domain, cursor) => ({
    url: `https://${domain}/products.json?limit=${SHOPIFY_PAGE_SIZE}&page=${cursor ?? '1'}`,
    method: 'GET',
    accept: 'application/json',
  }),
  parsePage(body, cursor) {
    const parsed = json(body, '/products.json');
    if (!isObject(parsed) || !Array.isArray(parsed.products))
      throw new ProductFeedSourceError('/products.json has no `products` array');
    const documents: ProductFeedDocument[] = [];
    for (const product of parsed.products) {
      if (!isObject(product)) continue;
      const id =
        typeof product.id === 'number' || typeof product.id === 'string' ? String(product.id) : '';
      if (!/^\d+$/u.test(id)) continue;
      documents.push({ externalId: id, payload: product });
    }
    const page = Number(cursor ?? '1');
    return parsed.products.length < SHOPIFY_PAGE_SIZE
      ? { documents }
      : { documents, nextCursor: String(page + 1) };
  },
  // A shopper browsing, not a crawler.
  pauseMs: 2_000,
  // 10,000 products a poll; a larger store finishes its walk over the next polls.
  pagesPerPoll: 40,
};

// ── The Steam store's game search, per market ──────────────────────────────

/** Market → the store's currency there and its language. */
export const STEAM_MARKETS: Readonly<Record<string, { currency: string; language: string }>> = {
  ES: { currency: 'EUR', language: 'spanish' },
  PT: { currency: 'EUR', language: 'portuguese' },
  FR: { currency: 'EUR', language: 'french' },
  IT: { currency: 'EUR', language: 'italian' },
  DE: { currency: 'EUR', language: 'german' },
  GB: { currency: 'GBP', language: 'english' },
  US: { currency: 'USD', language: 'english' },
};

/** Steam answers at most 100 rows a call. */
const STEAM_PAGE_SIZE = 100;
/** How deep one walk reads, in Steam's own relevance order: what that market actually buys. */
export const STEAM_MAX_RESULTS = 10_000;

const STEAM_ROW = /<a href="[^"]+"[^>]*?class="search_result_row[\s\S]*?<\/a>/gu;

export const steamStore: ProductFeedProvider = {
  kind: 'steam_store',
  meaning: `a market, as an ISO country code (${Object.keys(STEAM_MARKETS).join(', ')})`,
  canonicalIdentifier(raw) {
    const country = raw.trim().toUpperCase();
    return STEAM_MARKETS[country] ? country : undefined;
  },
  metaRequest: () => null,
  parseMeta(country) {
    const market = STEAM_MARKETS[country];
    if (!market) throw new ProductFeedSourceError(`Steam market ${country} is not mapped`);
    return { country, currency: market.currency, language: market.language };
  },
  pageRequest(country, cursor) {
    const market = STEAM_MARKETS[country];
    const params = new URLSearchParams({
      start: cursor ?? '0',
      count: String(STEAM_PAGE_SIZE),
      cc: country.toLowerCase(),
      l: market?.language ?? 'english',
      infinite: '1',
      // Games only: no DLC, soundtracks, software or videos.
      category1: '998',
      json: '1',
    });
    return {
      url: `https://store.steampowered.com/search/results/?${params.toString()}`,
      method: 'GET',
      accept: 'application/json',
    };
  },
  parsePage(body, cursor) {
    const parsed = json(body, 'the Steam search');
    if (!isObject(parsed) || typeof parsed.results_html !== 'string')
      throw new ProductFeedSourceError('the Steam search response has no `results_html`');
    const rows = [...parsed.results_html.matchAll(STEAM_ROW)].map((match) => match[0]);
    const documents: ProductFeedDocument[] = [];
    for (const html of rows) {
      // A bundle or a package is not one product and carries no app id.
      const appId = /data-ds-appid="(\d+)"/u.exec(html)?.[1];
      if (appId) documents.push({ externalId: appId, payload: { html } });
    }
    const total = typeof parsed.total_count === 'number' ? parsed.total_count : 0;
    // Steam may answer more rows than asked for; the next page starts after what it served.
    const next = Number(cursor ?? '0') + rows.length;
    return rows.length === 0 || next >= Math.min(total, STEAM_MAX_RESULTS)
      ? { documents }
      : { documents, nextCursor: String(next) };
  },
  pauseMs: 1_500,
  pagesPerPoll: STEAM_MAX_RESULTS / STEAM_PAGE_SIZE,
};

const PROVIDERS: Readonly<Record<ProductFeedKind, ProductFeedProvider>> = {
  shopify_storefront: shopifyStorefront,
  steam_store: steamStore,
};

export const PRODUCT_FEED_KINDS = Object.keys(PROVIDERS) as ProductFeedKind[];

export function productFeedProvider(kind: ProductFeedKind): ProductFeedProvider {
  return PROVIDERS[kind];
}
