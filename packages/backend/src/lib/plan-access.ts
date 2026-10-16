/**
 * Plan access & entitlements helper.
 * Resolves which plan features a user has from their subscription(s): the
 * features Clarity's own product reads, and the ones the capability
 * catalogue's feature gates answer Alia with (`capabilities/catalog/features.ts`).
 * Results are cached per-user with a short TTL.
 */

import { findActiveSubscriptions } from '../db/subscription-repository.js';
import { getPlans, getPlanFeatures } from './product-catalogue.js';

export interface Entitlements {
  features: Record<string, boolean | number>;
  planId: string | null;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, { data: Entitlements; expires: number }>();

export async function getUserEntitlements(userId: string): Promise<Entitlements> {
  const cached = cache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.data;

  const subscriptions = await findActiveSubscriptions(userId);

  const planIds = subscriptions.map((s) => s.planId).filter(Boolean) as string[];
  if (planIds.length === 0) planIds.push('free');

  // Fetch all product plans and filter client-side during the storage port.
  const [allPlans, allPlanFeatures] = await Promise.all([
    getPlans(),
    Promise.all(planIds.map((id) => getPlanFeatures(id))).then((results) => results.flat()),
  ]);
  const plans = allPlans.filter((p) => planIds.includes(p.planId));
  const planFeatures = allPlanFeatures.filter((pf) => pf.enabled !== false);

  const features: Record<string, boolean | number> = {};
  for (const pf of planFeatures) {
    if (pf.limitValue != null) {
      features[pf.featureId] = Math.max((features[pf.featureId] as number) || 0, pf.limitValue);
    } else {
      features[pf.featureId] = true;
    }
  }

  const highestPlan = plans.reduce<{ planId: string; sortOrder: number }>(
    (highest, plan) =>
      plan.sortOrder > highest.sortOrder
        ? { planId: plan.planId, sortOrder: plan.sortOrder }
        : highest,
    { planId: 'free', sortOrder: -1 },
  ).planId;

  const result: Entitlements = {
    features,
    planId: highestPlan,
  };

  cache.set(userId, { data: result, expires: Date.now() + CACHE_TTL });
  return result;
}

export function invalidateEntitlementsCache(userId: string): void {
  cache.delete(userId);
}
