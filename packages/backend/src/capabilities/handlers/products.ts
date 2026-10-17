import { z } from 'zod';

import {
  getProduct,
  ProductCatalogError,
  productIdSchema,
  productSearchSchema,
  searchProducts,
} from '../../search/products/mercaria-catalog.js';
import { type ClarityToolHandlers, parseInput, ToolError } from './context.js';

/** The route's own refusal, carried as the tool's. */
function rethrow(error: unknown): never {
  if (error instanceof ProductCatalogError) {
    throw new ToolError(error.status, error.code, error.message);
  }
  throw error;
}

const productInputSchema = z.object({ id: productIdSchema });

export const PRODUCT_HANDLERS: ClarityToolHandlers = {
  searchProducts: async (input) => {
    try {
      return { ...(await searchProducts(parseInput(productSearchSchema, input))) };
    } catch (error) {
      rethrow(error);
    }
  },
  getProduct: async (input) => {
    try {
      return { ...(await getProduct(parseInput(productInputSchema, input).id)) };
    } catch (error) {
      rethrow(error);
    }
  },
};
