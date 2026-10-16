import type { CatalogTool } from '@oxy.so/contracts';

import { CLARITY_MARKET_CAPABILITY, MAX_QUOTE_ASSETS } from '../../lib/market-data.js';
import { objectInput, readTool } from './define.js';

const { assets, unsupported, freshness } = CLARITY_MARKET_CAPABILITY;

export const MARKET_TOOLS: readonly CatalogTool[] = [
  readTool({
    name: 'getMarketQuotes',
    description: `Quote up to ${MAX_QUOTE_ASSETS} cryptocurrencies (CoinGecko, and FairCoin from the FairCoin explorer): price, 24h change, market cap, 24h volume, the source that produced the number and when (updatedAt). Each asset has its own outcome; one failing never removes the others. Always show source and updatedAt beside a price. ${assets.crypto.resolution} ${unsupported.equities} Quotes are cached for ${freshness.cacheSeconds} seconds.`,
    capability: 'market.read',
    input: objectInput(
      {
        assets: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_QUOTE_ASSETS,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            pattern: '^[A-Za-z0-9][A-Za-z0-9 .-]*$',
          },
          description: 'CoinGecko ids, symbols or names (e.g. "bitcoin", "eth"), or "faircoin".',
        },
        currency: {
          type: 'string',
          pattern: '^[A-Za-z]{2,10}$',
          default: 'usd',
          description: 'ISO currency code to quote in.',
        },
      },
      ['assets'],
    ),
  }),
];
