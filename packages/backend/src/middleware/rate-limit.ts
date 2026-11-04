import type { RequestHandler } from 'express';
import { createOxyRateLimit } from '@oxy.so/core/server';
import { type RedisReply, RedisStore } from 'rate-limit-redis';

import { log } from '../lib/logger.js';
import { getRedisClient } from '../lib/redis.js';
import { oxyClient } from './auth.js';

/**
 * Each surface counts in its own bucket: two unrelated public surfaces sharing
 * one counter would let reading the Finance page rate-limit the Jobs page,
 * which reads as a bug in whichever one the person opened second.
 */
export type RateLimitScope = 'jobs' | 'market' | 'news' | 'products' | 'v1-session';

/** Per minute. A signed-in person counts on their own, not with everyone behind their address. */
const WINDOW_MS = 60_000;
const ANONYMOUS_MAX = 20;
const AUTHENTICATED_MAX = 120;

/**
 * The scope's Valkey store, or none (the process's own memory) when Valkey is
 * not configured. Every limiter has its own prefix: `rate-limit-redis` keys
 * are `<prefix><key>`, so two limiters sharing one would share a counter.
 */
function scopeStore(scope: RateLimitScope): RedisStore | undefined {
  const redis = getRedisClient();
  if (!redis) {
    log.rateLimit.info({ scope }, 'Rate limiter using in-memory store (REDIS_URL not set)');
    return undefined;
  }
  return new RedisStore({
    prefix: `clarity:rl:${scope}:`,
    sendCommand: (command: string, ...args: string[]) =>
      redis.call(command, ...args) as Promise<RedisReply>,
  });
}

/**
 * Burst protection for one surface: Oxy's limiter, keyed per verified person
 * (or service) and otherwise per client address — `req.ip` under
 * `oxyTrustProxy`, hashed before it reaches the store, IPv6 bucketed to its
 * /56. A store that cannot be reached is an error, never a pass.
 *
 * Mount it AFTER the surface's own auth middleware. The limiter resolves the
 * session itself only when nothing has yet, so mounted first it would decide
 * the caller's identity without that surface's options (a strict optional
 * bearer, a supervised action).
 */
export function clarityRateLimit(scope: RateLimitScope): RequestHandler {
  const store = scopeStore(scope);
  return createOxyRateLimit(oxyClient, {
    windowMs: WINDOW_MS,
    anonymousMax: ANONYMOUS_MAX,
    authenticatedMax: AUTHENTICATED_MAX,
    message: 'Too many requests. Please retry shortly.',
    ...(store ? { store } : {}),
  });
}
