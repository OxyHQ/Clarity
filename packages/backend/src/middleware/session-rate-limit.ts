import type { NextFunction, Request, Response } from 'express';

import { findActiveSubscription } from '../db/subscription-repository.js';
import { checkLimit } from '../lib/sliding-window-limiter.js';
import { log } from '../lib/logger.js';

type Tier = 'free' | 'pro' | 'pro_plus' | 'business' | 'enterprise';

const TIER_BY_PLAN_ID: Readonly<Record<string, Tier>> = Object.freeze({
  free: 'free',
  go: 'pro',
  pro: 'pro',
  max: 'pro_plus',
  ultra: 'business',
  'codea-pro': 'pro',
  'codea-max': 'pro_plus',
});

export async function getUserTier(userId: string): Promise<Tier> {
  const subscription = await findActiveSubscription(userId);
  if (!subscription) return 'free';
  return subscription.planId ? TIER_BY_PLAN_ID[subscription.planId] ?? 'free' : 'free';
}

/** Burst protection for authenticated user sessions; Alia owns usage limits. */
export async function sessionRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.user?.id || req.serviceApp) {
    next();
    return;
  }
  try {
    const tier = await getUserTier(req.user.id);
    const result = await checkLimit(req.user.id, tier);
    if (result.allowed) {
      next();
      return;
    }
    res.status(429).json({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please retry after the indicated delay.',
        retryable: true,
        retryAfter: result.resetInSeconds,
      },
    });
  } catch (error) {
    log.rateLimit.error({ err: error }, 'Session rate limit check failed open');
    next();
  }
}
