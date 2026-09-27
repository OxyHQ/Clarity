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
import { Router } from 'express';

import { log } from '../lib/logger.js';
import { anonymousRateLimit } from '../middleware/anonymous-rate-limit.js';
import { sendError } from '../middleware/resource-auth.js';
import { listNewsStories } from '../search/news.js';

const router = Router();

/** Its own bucket: reading Discover must not rate-limit Jobs or Finance. */
router.use(anonymousRateLimit('anon:news:'));

router.get('/', async (req, res) => {
  try {
    const { limit, languages } = req.query;
    let data = await listNewsStories({ limit, languages });
    // A reader's languages with no news yet get every language, not an empty
    // page — decided here, in one request, rather than by a second round trip.
    if (data.length === 0 && languages) data = await listNewsStories({ limit });
    // The same answer for every anonymous reader: let a shared cache hold it.
    res.setHeader('cache-control', 'public, max-age=60');
    res.json({ data });
  } catch (error) {
    log.general.error({ err: error }, 'News listing failed');
    sendError(res, 503, 'news_unavailable', 'News is temporarily unavailable', req);
  }
});

export default router;
