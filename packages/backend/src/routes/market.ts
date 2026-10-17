import { optionalAuth } from '../middleware/auth.js';
/**
 * The public market quote surface behind `clarity.surf`'s Finance page.
 *
 * A price is public information in the same way a job posting is, so this
 * router carries no credential and no user identity — exactly like `/jobs`,
 * and for the same reason: nothing here reads a session and no request is
 * attributable to a person. Burst protection is keyed by address instead.
 *
 * This is a SECOND door onto `lib/market-data.ts`, not a second implementation
 * of it. The first, `/v1/market`, is the credentialed machine surface: it wants
 * an `oxy_sk` resource credential and the `clarity:market` scope, which is the
 * right shape for Alia's tool layer and the wrong shape for Clarity's own
 * frontend — a browser holding a user session has no resource credential to
 * present, and `clarity:market` is not yet in Oxy's scope vocabulary anyway.
 * Both doors call the same module, so fetching, range slicing and the shared
 * Redis cache exist once.
 *
 * `/quotes` answers SUMMARIES — a price with its provenance, no chart history.
 * The Finance cards draw no chart, and CoinGecko's full daily series for a
 * long-lived coin is thousands of points per asset; shipping four of those to
 * render four numbers would be the most expensive part of the page. A consumer
 * that wants history asks `/v1/market/quote/:asset`, which returns it. The two
 * cases are separate TYPES rather than an optional field so that an empty
 * history can never be mistaken for a door that does not serve one.
 */
import { Router } from 'express';
import { z } from 'zod';

import {
  CLARITY_MARKET_CAPABILITY,
  getMarketQuoteSummaries,
  MARKET_ASSET_PATTERN,
  MAX_QUOTE_ASSETS,
} from '../lib/market-data.js';
import { anonymousRateLimit } from '../middleware/anonymous-rate-limit.js';
import { sendError } from '../middleware/resource-auth.js';

const router = Router();
// This surface is not reviewed for supervised consumption. Presented bearers never downgrade to anonymous.
router.use(optionalAuth);

/**
 * Burst protection for an anonymous surface, keyed by address, never by user.
 *
 * Its own bucket rather than `/jobs`'s: two unrelated public surfaces sharing
 * one counter means reading the Finance page rate-limits the Jobs page, which
 * would read as a bug in whichever one the person opened second.
 */
router.use(anonymousRateLimit('anon:market:'));

const assetSchema = z.string().trim().min(1).max(64).regex(MARKET_ASSET_PATTERN);

const quotesQuerySchema = z
  .object({
    assets: z
      .string()
      .trim()
      .min(1)
      .transform((value) =>
        value
          .split(',')
          .map((asset) => asset.trim())
          .filter(Boolean),
      ),
    currency: z
      .string()
      .trim()
      .regex(/^[a-z]{2,10}$/i)
      .default('usd'),
  })
  .refine((query) => query.assets.length > 0 && query.assets.length <= MAX_QUOTE_ASSETS, {
    message: `assets must name between 1 and ${MAX_QUOTE_ASSETS} assets`,
    path: ['assets'],
  })
  .refine((query) => query.assets.every((asset) => assetSchema.safeParse(asset).success), {
    message: 'each asset must be a cryptocurrency id, symbol or name',
    path: ['assets'],
  });

router.get('/capability', (_req, res) => res.json(CLARITY_MARKET_CAPABILITY));

router.get('/quotes', async (req, res) => {
  const query = quotesQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendError(
      res,
      400,
      'invalid_request',
      'assets must be a comma-separated list of cryptocurrency ids, symbols or names',
      req,
      {
        issues: query.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    );
    return;
  }
  res.json(await getMarketQuoteSummaries(query.data.assets, query.data.currency));
});

export default router;
