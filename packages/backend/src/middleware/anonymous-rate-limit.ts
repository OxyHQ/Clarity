import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

import { checkLimit } from '../lib/sliding-window-limiter.js';
import { sendError } from './resource-auth.js';

/**
 * The bucket an anonymous caller counts in: a digest of its address, never the
 * address itself, because the key is written to Valkey. IPv6 is bucketed to its
 * /56 first, so one host cannot mint fresh buckets by rotating through its
 * allocation.
 *
 * `ip` is `req.ip`, which `index.ts` derives with `oxyTrustProxy`: the real
 * client behind the ALB and, on a proxied hostname, behind Cloudflare, and
 * never an address a caller wrote into `X-Forwarded-For` itself.
 */
export function anonymousCallerKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  return createHash('sha256')
    .update(`clarity|anon-rl|${ipKeyGenerator(ip)}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Burst protection for an anonymous public surface, keyed by address, never by
 * user. Each surface passes its own bucket prefix: two unrelated surfaces
 * sharing one counter would let reading one rate-limit the other.
 */
export function anonymousRateLimit(bucketPrefix: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const result = await checkLimit(`${bucketPrefix}${anonymousCallerKey(req.ip)}`, 'free');
    if (result.allowed) {
      next();
      return;
    }
    res.setHeader('retry-after', String(result.resetInSeconds ?? 60));
    sendError(res, 429, 'rate_limited', 'Too many requests. Please retry shortly.', req);
  };
}
