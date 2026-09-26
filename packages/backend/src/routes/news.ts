/**
 * The public news surface behind `clarity.surf`'s Discover page.
 *
 * A published news article is public information in the same way a job posting
 * or a price is, so this router carries no credential and no user identity —
 * exactly like `/jobs` and `/market`. Burst protection is keyed by address.
 *
 * This is a SECOND door onto `search/news.ts`, not a second implementation of
 * it. The first, `/v1/news`, is the credentialed machine surface and wants an
 * `oxy_sk` resource credential a browser holding a user session does not have.
 */
import { Router, type Request, type Response } from 'express';

import { log } from '../lib/logger.js';
import { getClientIp } from '../lib/net-utils.js';
import { checkLimit } from '../lib/sliding-window-limiter.js';
import { sendError } from '../middleware/resource-auth.js';
import { listNewsStories } from '../search/news.js';

const router = Router();

/** Its own bucket: reading Discover must not rate-limit Jobs or Finance. */
router.use(async (req: Request, res: Response, next) => {
  const result = await checkLimit(`anon:news:${getClientIp(req)}`, 'free');
  if (result.allowed) { next(); return; }
  res.setHeader('retry-after', String(result.resetInSeconds ?? 60));
  sendError(res, 429, 'rate_limited', 'Too many requests. Please retry shortly.', req);
});

router.get('/', async (req, res) => {
  try {
    res.json({ data: await listNewsStories(req.query.limit) });
  } catch (error) {
    log.general.error({ err: error }, 'News listing failed');
    sendError(res, 503, 'news_unavailable', 'News is temporarily unavailable', req);
  }
});

export default router;
