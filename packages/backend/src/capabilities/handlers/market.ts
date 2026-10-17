import { z } from 'zod';

import {
  getMarketQuoteSummaries,
  MARKET_ASSET_PATTERN,
  MAX_QUOTE_ASSETS,
} from '../../lib/market-data.js';
import { type ClarityToolHandlers, parseInput } from './context.js';

const quotesSchema = z.object({
  assets: z
    .array(z.string().trim().min(1).max(64).regex(MARKET_ASSET_PATTERN))
    .min(1)
    .max(MAX_QUOTE_ASSETS),
  currency: z
    .string()
    .trim()
    .regex(/^[a-z]{2,10}$/i)
    .default('usd'),
});

export const MARKET_HANDLERS: ClarityToolHandlers = {
  getMarketQuotes: async (input) => {
    const { assets, currency } = parseInput(quotesSchema, input);
    return getMarketQuoteSummaries(assets, currency);
  },
};
