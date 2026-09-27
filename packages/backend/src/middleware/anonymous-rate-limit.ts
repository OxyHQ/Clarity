import type { NextFunction, Request, Response } from 'express';

import { getClientIp } from '../lib/net-utils.js';
import { checkLimit } from '../lib/sliding-window-limiter.js';
import { sendError } from './resource-auth.js';

/**
 * Burst protection for an anonymous public surface, keyed by address, never by
 * user. Each surface passes its own bucket prefix: two unrelated surfaces
 * sharing one counter would let reading one rate-limit the other.
 */
export function anonymousRateLimit(bucketPrefix: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const result = await checkLimit(`${bucketPrefix}${getClientIp(req)}`, 'free');
    if (result.allowed) { next(); return; }
    res.setHeader('retry-after', String(result.resetInSeconds ?? 60));
    sendError(res, 429, 'rate_limited', 'Too many requests. Please retry shortly.', req);
  };
}
