/**
 * Clarity's products vertical: shopping search, answered by Mercaria.
 *
 * Mercaria owns the catalogue — canonical products, every seller's offer,
 * matching and prices — and serves it on `/public/v1/catalog/*`
 * (`~/Oxy/docs/api-conventions.md`, "Cross-app references": the owner serves
 * its facts by SDK). Clarity reads it here, through `@mercaria.co/sdk`, at
 * query time. Nothing is stored: no table, no cache of prices, so a price
 * Clarity shows is the one Mercaria answered with a moment ago.
 *
 * This is the ONE importer of `@mercaria.co/sdk`. Both doors — the public
 * `/products` router and the credentialed `/v1/products` — and the capability
 * catalogue's tools call the functions below.
 *
 * ## Order is Mercaria's
 *
 * Results keep Mercaria's relevance order and offers its ranked order. Nothing
 * here sorts, filters by seller or weights anything: Clarity's commercial
 * signals (plans, payments, Mercaria or Mention engagement) never reach a
 * product's position, the rule `AGENTS.md` holds for Jobs.
 *
 * ## Who Clarity is to Mercaria
 *
 * Every request carries Clarity's own Oxy service token, so Mercaria meters
 * Clarity as one service application rather than as an anonymous address. The
 * token grants no read an anonymous caller lacks. When this process cannot mint
 * one (a local run with no service identity), the read goes anonymously.
 */

import {
  createMercariaClient,
  type MercariaCatalogProduct,
  type MercariaCatalogProductSummary,
  type MercariaClient,
  MercariaBadRequestError,
  type MercariaFetch,
  MercariaGoneError,
  type MercariaMoney,
  MercariaNotFoundError,
  type MercariaOffer,
  MercariaValidationError,
} from '@mercaria.co/sdk';
import { z } from 'zod';

import type {
  ProductDetail,
  ProductMoney,
  ProductOffer,
  ProductSearchResponse,
  ProductSource,
  ProductSummary,
} from '@clarity/shared-types';
import {
  getClarityServiceToken,
  hasExactClarityServiceConfiguration,
} from '../../lib/clarity-service-auth.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('products');

/** The longest query Mercaria accepts. */
export const PRODUCT_QUERY_MAX_LENGTH = 200;
/** The largest page Mercaria serves. */
export const PRODUCT_PAGE_LIMIT_MAX = 50;
export const PRODUCT_PAGE_LIMIT_DEFAULT = 20;

export const PRODUCT_SOURCE: ProductSource = Object.freeze({
  name: 'Mercaria',
  url: 'https://mercaria.co',
});

/** A refusal with the status and code a door answers with. */
export class ProductCatalogError extends Error {
  constructor(
    readonly status: 400 | 404 | 410 | 503,
    readonly code: 'invalid_request' | 'not_found' | 'gone' | 'products_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ProductCatalogError';
  }
}

/** Clarity's token for Mercaria, or `null` to read anonymously. Never throws. */
async function clarityToken(): Promise<string | null> {
  if (!hasExactClarityServiceConfiguration()) return null;
  try {
    return await getClarityServiceToken();
  } catch (error) {
    log.warn({ err: error }, 'could not mint a service token for Mercaria; reading anonymously');
    return null;
  }
}

let client: MercariaClient | undefined;

function mercaria(): MercariaClient {
  client ??= createMercariaClient({ getAccessToken: clarityToken });
  return client;
}

/** Tests only: a client on a stubbed `fetch`, anonymous. `undefined` restores the default. */
export function setMercariaFetchForTests(fetch: MercariaFetch | undefined): void {
  client = fetch === undefined ? undefined : createMercariaClient({ fetch });
}

/** Every SDK failure as a door's answer. Only refusals keep Mercaria's meaning. */
function refusal(error: unknown): ProductCatalogError {
  if (error instanceof MercariaNotFoundError) {
    return new ProductCatalogError(404, 'not_found', 'No such product');
  }
  if (error instanceof MercariaGoneError) {
    return new ProductCatalogError(410, 'gone', 'This product is no longer available');
  }
  if (error instanceof MercariaBadRequestError || error instanceof MercariaValidationError) {
    return new ProductCatalogError(400, 'invalid_request', error.message);
  }
  log.warn({ err: error }, 'Mercaria could not answer a product read');
  return new ProductCatalogError(
    503,
    'products_unavailable',
    'Product search is unavailable right now. Try again shortly.',
  );
}

function money(value: MercariaMoney | null | undefined): ProductMoney | null {
  return value ? { amount: value.amount, currency: value.currency } : null;
}

function summary(product: MercariaCatalogProductSummary): ProductSummary {
  return {
    id: product.ref.id,
    name: product.name,
    imageUrl: product.image?.url ?? null,
    url: product.url,
    offers: product.offers
      ? {
          count: product.offers.count,
          availability: product.offers.availability,
          lowestPrice: money(product.offers.lowestPrice),
        }
      : null,
  };
}

function offer(value: MercariaOffer, link: string | null): ProductOffer {
  const seller = value.seller;
  return {
    id: value.id,
    kind: value.kind,
    variantId: value.variantId,
    seller:
      seller.kind === 'merchant'
        ? { kind: 'merchant', name: seller.name, domain: seller.domain }
        : seller.kind === 'store'
          ? { kind: 'store', name: seller.name }
          : seller.kind === 'person'
            ? { kind: 'person', name: seller.displayName }
            : { kind: 'unknown' },
    price: money(value.price),
    availability: value.availability,
    condition: value.condition ? { key: value.condition.key, group: value.condition.group } : null,
    observedAt: value.observedAt,
    link,
    rel: value.action.kind === 'outbound' ? value.action.rel : null,
    destinationHost:
      value.action.kind === 'mercaria_checkout' ? null : value.action.destinationHost,
    attribution: value.source
      ? {
          name: value.source.name,
          homepage: value.source.homepage,
          licence: value.source.licenceLabel,
        }
      : null,
  };
}

function detail(product: MercariaCatalogProduct, sdk: MercariaClient): ProductDetail {
  return {
    id: product.ref.id,
    name: product.name,
    description: product.description,
    imageUrl: product.image?.url ?? null,
    images: product.images.map((image) => image.url),
    url: product.url,
    variants: product.variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      gtins: [...variant.gtins],
    })),
    offers:
      product.offers === null
        ? null
        : product.offers.map((entry) => offer(entry, sdk.links.offer(entry))),
    source: PRODUCT_SOURCE,
  };
}

/**
 * What a product search may carry — the ONE schema both doors and the tool
 * parse with. `limit` is coerced because a query string carries it as text.
 */
export const productSearchSchema = z.object({
  query: z.string().trim().min(1).max(PRODUCT_QUERY_MAX_LENGTH),
  market: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'market must be an ISO 3166-1 alpha-2 country code')
    .transform((value) => value.toUpperCase())
    .optional(),
  limit: z.coerce.number().int().min(1).max(PRODUCT_PAGE_LIMIT_MAX).optional(),
  cursor: z.string().min(1).max(512).optional(),
});
export type ProductSearchInput = z.infer<typeof productSearchSchema>;

/** A Mercaria catalog product id: opaque, never a path. */
export const productIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'not a product id');

/** One page of products for `query`, in Mercaria's order. */
export async function searchProducts(input: ProductSearchInput): Promise<ProductSearchResponse> {
  const sdk = mercaria();
  try {
    const page = await sdk.catalog.search({
      query: input.query,
      ...(input.market === undefined ? {} : { market: input.market }),
      limit: input.limit ?? PRODUCT_PAGE_LIMIT_DEFAULT,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    return {
      results: page.items.map(summary),
      nextCursor: page.nextCursor,
      source: PRODUCT_SOURCE,
    };
  } catch (error) {
    throw refusal(error);
  }
}

/** One product and every current offer, ranked by Mercaria. */
export async function getProduct(id: string): Promise<ProductDetail> {
  const sdk = mercaria();
  try {
    return detail(await sdk.catalog.get(id), sdk);
  } catch (error) {
    throw refusal(error);
  }
}
