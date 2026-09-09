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
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type { MarketQuoteResult } from '@clarity/shared-types';

import { log } from '../lib/logger.js';
import { CLARITY_MARKET_CAPABILITY, MarketDataError, getMarketQuote } from '../lib/market-data.js';
import { getClientIp } from '../lib/net-utils.js';
import { checkLimit } from '../lib/sliding-window-limiter.js';
import { sendError } from '../middleware/resource-auth.js';

const router = Router();

/**
 * Burst protection for an anonymous surface, keyed by address, never by user.
 *
 * Its own bucket rather than `/jobs`'s: two unrelated public surfaces sharing
 * one counter means reading the Finance page rate-limits the Jobs page, which
 * would read as a bug in whichever one the person opened second.
 */
router.use(async (req: Request, res: Response, next) => {
  const result = await checkLimit(`anon:market:${getClientIp(req)}`, 'free');
  if (result.allowed) { next(); return; }
  res.setHeader('retry-after', String(result.resetInSeconds ?? 60));
  sendError(res, 429, 'rate_limited', 'Too many requests. Please retry shortly.', req);
});

/** A CoinGecko id, symbol or name, or a FairCoin alias. Never a URL or a path. */
const assetSchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9 .-]*$/i);

/**
 * One page of cards, and no more. Each asset costs several upstream calls on a
 * cold cache, so the batch bounds what a single anonymous request can spend.
 */
const MAX_ASSETS = 8;

const quotesQuerySchema = z.object({
  assets: z.string().trim().min(1).transform((value) => value.split(',').map((asset) => asset.trim()).filter(Boolean)),
  currency: z.string().trim().regex(/^[a-z]{2,10}$/i).default('usd'),
}).refine((query) => query.assets.length > 0 && query.assets.length <= MAX_ASSETS, {
  message: `assets must name between 1 and ${MAX_ASSETS} assets`,
  path: ['assets'],
}).refine((query) => query.assets.every((asset) => assetSchema.safeParse(asset).success), {
  message: 'each asset must be a cryptocurrency id, symbol or name',
  path: ['assets'],
});

router.get('/capability', (_req, res) => res.json(CLARITY_MARKET_CAPABILITY));

router.get('/quotes', async (req, res) => {
  const query = quotesQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendError(res, 400, 'invalid_request', 'assets must be a comma-separated list of cryptocurrency ids, symbols or names', req, {
      issues: query.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
    return;
  }
  const { assets, currency } = query.data;
  const results = await Promise.all(assets.map((asset) => quoteResult(asset, currency)));
  res.json({ results });
});

/**
 * One asset's outcome. An upstream that is down for FairCoin must not take
 * Bitcoin's price off the page with it, so a failure is a value here rather
 * than a rejection.
 */
async function quoteResult(requested: string, currency: string): Promise<MarketQuoteResult> {
  try {
    const quote = await getMarketQuote(requested, { currency });
    // Named field by field rather than spread-minus-`series`: a field added to
    // the summary type is then a compile error here rather than a field this
    // door silently stops serving.
    return {
      requested,
      status: 'quoted',
      quote: {
        asset: quote.asset,
        name: quote.name,
        symbol: quote.symbol,
        currency: quote.currency,
        price: quote.price,
        changePct: quote.changePct,
        changeAbs: quote.changeAbs,
        marketCap: quote.marketCap,
        volume24h: quote.volume24h,
        liquidityUsd: quote.liquidityUsd,
        source: quote.source,
        updatedAt: quote.updatedAt,
      },
    };
  } catch (error) {
    if (error instanceof MarketDataError) {
      return { requested, status: 'unavailable', error: { code: error.code, message: error.message } };
    }
    log.general.error({ err: error, asset: requested }, 'Market quote failed');
    return {
      requested,
      status: 'unavailable',
      error: { code: 'quote_unavailable', message: 'This quote is temporarily unavailable' },
    };
  }
}

export default router;
