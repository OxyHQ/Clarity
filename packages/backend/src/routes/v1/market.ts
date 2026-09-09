/**
 * Market data for Clarity's Finance surface.
 *
 * Authorised the way the rest of the credentialed `/v1` surface is — an
 * `oxy_sk` resource credential introspected by Oxy, a per-credential request
 * ceiling, then an explicit scope — but under its OWN scope, `clarity:market`.
 *
 * Deliberately not `clarity:search`: that scope gates Clarity's indexed corpus,
 * carries the monthly `search_month` quota and is what a search-platform
 * customer buys. Market quotes are neither indexed by Clarity nor billable as
 * searches. Putting them behind `clarity:search` would hand every existing
 * search customer a market feed nobody granted them, and would force the two
 * consumers this exists for — Clarity's own Finance page and, later, Alia's
 * tool layer — to hold a corpus-search credential to read a price. It is not
 * `clarity:index` either: nothing here writes.
 */
import { Router } from 'express';
import { z } from 'zod';

import {
  CLARITY_MARKET_CAPABILITY, getMarketQuote, MarketDataError,
} from '../../lib/market-data.js';
import {
  authenticateResource, requireResourceRequestRate, requireResourceScope, sendError,
} from '../../middleware/resource-auth.js';

const router = Router();
router.use(authenticateResource);
router.use(requireResourceRequestRate);

/** A CoinGecko id, symbol or name, or a FairCoin alias. Never a URL or a path. */
const assetSchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9 .-]*$/i);
const quoteQuerySchema = z.object({ currency: z.string().trim().regex(/^[a-z]{2,10}$/i).default('usd') });

router.get('/capability', requireResourceScope('clarity:market'), (_req, res) => res.json(CLARITY_MARKET_CAPABILITY));

router.get('/quote/:asset', requireResourceScope('clarity:market'), async (req, res) => {
  const asset = assetSchema.safeParse(req.params.asset);
  if (!asset.success) {
    sendError(res, 400, 'invalid_request', 'asset must be a cryptocurrency id, symbol or name', req);
    return;
  }
  const query = quoteQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendError(res, 400, 'invalid_request', 'currency must be an ISO currency code', req, {
      issues: query.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
    return;
  }
  try {
    res.json(await getMarketQuote(asset.data, { currency: query.data.currency }));
  } catch (error) {
    if (error instanceof MarketDataError) {
      sendError(res, error.status, error.code, error.message, req);
      return;
    }
    throw error;
  }
});

export default router;
