import { and, eq, gt, gte, isNull, lt, lte, or, sql } from 'drizzle-orm';

import { getDb, type ClarityExecutor } from '../db/index.js';
import {
  searchQuotaGrants, searchRateLimitBuckets, searchUsageEvents, searchUsageRollups,
} from '../db/schema/index.js';
import type { ClarityResourcePrincipal } from '../middleware/resource-auth.js';

export const SANDBOX_QUOTAS = {
  search_month: 10_000,
  fetch_month: 5_000,
  sites: 1,
  active_crawls: 2,
  pages_per_crawl: 5_000,
  requests_minute_credential: 60,
  requests_minute_application: 300,
  concurrent_fetches: 2,
} as const;

export type QuotaMetric = keyof typeof SANDBOX_QUOTAS;
export type BillableOperation = 'search' | 'fetch_started' | 'page_indexed' | 'browser_render';

const operationMetric: Partial<Record<BillableOperation, QuotaMetric>> = {
  search: 'search_month',
  fetch_started: 'fetch_month',
};

export async function effectiveQuota(executor: ClarityExecutor, accountId: string, metric: QuotaMetric, now = new Date()): Promise<number> {
  const [{ additional }] = await executor.select({
    additional: sql<number>`coalesce(sum(${searchQuotaGrants.additionalLimit}), 0)::int`,
  }).from(searchQuotaGrants).where(and(
    eq(searchQuotaGrants.ownerAccountId, accountId),
    eq(searchQuotaGrants.metric, metric),
    lte(searchQuotaGrants.startsAt, now),
    or(isNull(searchQuotaGrants.expiresAt), gt(searchQuotaGrants.expiresAt, now)),
  ));
  return SANDBOX_QUOTAS[metric] + additional;
}

export async function consumeUsage(input: {
  principal: Pick<ClarityResourcePrincipal, 'accountId' | 'applicationId' | 'credentialId'>;
  operation: BillableOperation;
  idempotencyKey?: string;
  quantity?: number;
  now?: Date;
}): Promise<{ accepted: boolean; duplicate: boolean; limit?: number; used?: number }> {
  const quantity = input.quantity ?? 1;
  const now = input.now ?? new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.principal.accountId}:${input.operation}:${periodStart.toISOString()}`}, 0))`);
    if (input.idempotencyKey) {
      const [existing] = await tx.select({ id: searchUsageEvents.id }).from(searchUsageEvents).where(and(
        eq(searchUsageEvents.ownerAccountId, input.principal.accountId),
        eq(searchUsageEvents.operation, input.operation),
        eq(searchUsageEvents.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (existing) return { accepted: true, duplicate: true };
    }
    const metric = operationMetric[input.operation];
    let limit: number | undefined;
    let used: number | undefined;
    if (metric) {
      limit = await effectiveQuota(tx, input.principal.accountId, metric, now);
      const [current] = await tx.select({ quantity: sql<number>`coalesce(sum(${searchUsageEvents.quantity}), 0)::int` }).from(searchUsageEvents).where(and(
        eq(searchUsageEvents.ownerAccountId, input.principal.accountId),
        eq(searchUsageEvents.operation, input.operation),
        gte(searchUsageEvents.occurredAt, periodStart),
        lt(searchUsageEvents.occurredAt, periodEnd),
      ));
      used = current.quantity;
      if (used + quantity > limit) return { accepted: false, duplicate: false, limit, used };
    }
    await tx.insert(searchUsageEvents).values({
      id: crypto.randomUUID(), ownerAccountId: input.principal.accountId,
      applicationId: input.principal.applicationId, credentialId: input.principal.credentialId,
      operation: input.operation, idempotencyKey: input.idempotencyKey, quantity, occurredAt: now,
    });
    await tx.insert(searchUsageRollups).values({
      ownerAccountId: input.principal.accountId, applicationId: input.principal.applicationId,
      credentialId: input.principal.credentialId ?? '', operation: input.operation,
      periodStart, periodEnd, quantity, updatedAt: now,
    }).onConflictDoUpdate({
      target: [searchUsageRollups.ownerAccountId, searchUsageRollups.applicationId, searchUsageRollups.credentialId, searchUsageRollups.operation, searchUsageRollups.periodStart],
      set: { quantity: sql`${searchUsageRollups.quantity} + ${quantity}`, periodEnd, updatedAt: now },
    });
    return { accepted: true, duplicate: false, limit, used: used === undefined ? undefined : used + quantity };
  });
}

export async function consumeRequestRate(principal: Pick<ClarityResourcePrincipal, 'accountId' | 'applicationId' | 'credentialId'>, now = new Date()): Promise<{ accepted: boolean; retryAfterSeconds?: number }> {
  const bucketStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const expiresAt = new Date(bucketStart.getTime() + 120_000);
  const dimensions = [
    { dimension: 'application' as const, id: principal.applicationId, metric: 'requests_minute_application' as const },
    ...(principal.credentialId ? [{ dimension: 'credential' as const, id: principal.credentialId, metric: 'requests_minute_credential' as const }] : []),
  ];
  return getDb().transaction(async (tx) => {
    for (const item of dimensions) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${item.dimension}:${item.id}:${bucketStart.toISOString()}`}, 0))`);
    }
    for (const item of dimensions) {
      const limit = await effectiveQuota(tx, principal.accountId, item.metric, now);
      const [bucket] = await tx.select({ quantity: searchRateLimitBuckets.quantity }).from(searchRateLimitBuckets).where(and(
        eq(searchRateLimitBuckets.dimension, item.dimension), eq(searchRateLimitBuckets.dimensionId, item.id), eq(searchRateLimitBuckets.bucketStart, bucketStart),
      )).limit(1);
      if ((bucket?.quantity ?? 0) >= limit) return { accepted: false, retryAfterSeconds: Math.max(1, Math.ceil((bucketStart.getTime() + 60_000 - now.getTime()) / 1000)) };
    }
    for (const item of dimensions) {
      await tx.insert(searchRateLimitBuckets).values({ dimension: item.dimension, dimensionId: item.id, bucketStart, quantity: 1, expiresAt }).onConflictDoUpdate({
        target: [searchRateLimitBuckets.dimension, searchRateLimitBuckets.dimensionId, searchRateLimitBuckets.bucketStart],
        set: { quantity: sql`${searchRateLimitBuckets.quantity} + 1`, expiresAt },
      });
    }
    return { accepted: true };
  });
}
