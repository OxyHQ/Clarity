import type { CatalogTool } from '@oxy.so/contracts';

import {
  PRODUCT_PAGE_LIMIT_MAX,
  PRODUCT_QUERY_MAX_LENGTH,
} from '../../search/products/mercaria-catalog.js';
import { integerInput, objectInput, readTool, textInput } from './define.js';

const ANSWERED_BY =
  'Answered by Mercaria, which owns the catalogue: always say so, and link the url it returns.';

export const PRODUCT_TOOLS: readonly CatalogTool[] = [
  readTool({
    name: 'searchProducts',
    description: `Search products to buy — new from shops, secondhand from people, and retailers' and open-data prices — by words or a barcode (GTIN). Each result is one product (a model, compared across every seller), with how many current offers it has, their availability and the lowest current price in its own currency (null when none can be stated; never invent one). Results are in Mercaria's relevance order: keep it. ${ANSWERED_BY}`,
    capability: 'search.products.read',
    input: objectInput(
      {
        query: textInput(PRODUCT_QUERY_MAX_LENGTH),
        market: {
          type: 'string',
          pattern: '^[A-Za-z]{2}$',
          description: 'ISO 3166-1 alpha-2 country, e.g. "ES": only offers published for it.',
        },
        limit: integerInput(1, PRODUCT_PAGE_LIMIT_MAX),
        cursor: {
          type: 'string',
          minLength: 1,
          maxLength: 512,
          description: 'The previous page’s nextCursor, verbatim, with the same query.',
        },
      },
      ['query'],
    ),
  }),
  readTool({
    name: 'getProduct',
    description: `One product from searchProducts by id: its configurations (with barcodes) and every current offer in Mercaria's ranked order — seller, price in the offer's own currency, availability, condition, when it was seen, and the link to follow. Never re-rank offers or call one "best" beyond that order. Show an offer's attribution when it has one. offers is null while Mercaria is not serving price comparison, which never means nobody sells it. ${ANSWERED_BY}`,
    capability: 'search.products.read',
    input: objectInput({ id: { type: 'string', minLength: 1, maxLength: 128 } }, ['id']),
  }),
];
