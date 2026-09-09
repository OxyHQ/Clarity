import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { searchQuotaGrants, searchUsageEvents, searchUsageRollups } from '../../db/schema/index.js';
import { consumeRequestRate, consumeUsage, effectiveQuota, SANDBOX_QUOTAS } from '../quotas.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;
const accountId = `quota-test-${crypto.randomUUID()}`;
const principal = { accountId, applicationId: 'quota-app', credentialId: 'quota-credential' };

suite('Clarity quota ledger on PostgreSQL', () => {
  beforeAll(() => {
    if (new URL(databaseUrl).pathname.slice(1) !== 'clarity_ci') throw new Error('integration tests require database clarity_ci');
    connectPostgres(databaseUrl);
  });

  afterAll(async () => {
    const client = postgres(databaseUrl, { max: 1 });
    await client`delete from clarity_search_rate_limit_buckets where dimension_id in (${principal.applicationId}, ${principal.credentialId})`;
    await client`delete from clarity_search_usage_events where owner_account_id = ${accountId}`;
    await client`delete from clarity_search_usage_rollups where owner_account_id = ${accountId}`;
    await client`delete from clarity_search_quota_grants where owner_account_id = ${accountId}`;
    await client.end();
    await closePostgres();
  });

  it('admits only one concurrent charge at the monthly boundary', async () => {
    const results = await Promise.all([
      consumeUsage({ principal, operation: 'search', quantity: 6_000, idempotencyKey: 'parallel-a' }),
      consumeUsage({ principal, operation: 'search', quantity: 6_000, idempotencyKey: 'parallel-b' }),
    ]);
    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results.filter((result) => !result.accepted)).toEqual([expect.objectContaining({ limit: SANDBOX_QUOTAS.search_month, used: 6_000 })]);
  });

  it('does not charge an idempotent retry twice', async () => {
    const first = await consumeUsage({ principal, operation: 'fetch_started', quantity: 2, idempotencyKey: 'same-fetch' });
    const retry = await consumeUsage({ principal, operation: 'fetch_started', quantity: 2, idempotencyKey: 'same-fetch' });
    expect(first).toMatchObject({ accepted: true, duplicate: false });
    expect(retry).toEqual({ accepted: true, duplicate: true });

    const events = await getDb().select().from(searchUsageEvents);
    const rollups = await getDb().select().from(searchUsageRollups);
    expect(events.filter((event) => event.ownerAccountId === accountId && event.operation === 'fetch_started')).toHaveLength(1);
    expect(rollups.find((rollup) => rollup.ownerAccountId === accountId && rollup.operation === 'fetch_started')?.quantity).toBe(2);
  });

  it('adds active staff grants to the sandbox limit', async () => {
    await getDb().insert(searchQuotaGrants).values({
      id: crypto.randomUUID(), ownerAccountId: accountId, metric: 'sites', additionalLimit: 3,
      reason: 'enterprise beta', grantedBy: 'staff-user',
    });
    expect(await effectiveQuota(getDb(), accountId, 'sites')).toBe(SANDBOX_QUOTAS.sites + 3);
  });

  it('enforces credential and application minute buckets', async () => {
    const now = new Date('2026-09-09T12:34:10.000Z');
    for (let request = 0; request < SANDBOX_QUOTAS.requests_minute_credential; request += 1) {
      await expect(consumeRequestRate(principal, now)).resolves.toEqual({ accepted: true });
    }
    await expect(consumeRequestRate(principal, now)).resolves.toEqual({ accepted: false, retryAfterSeconds: 50 });
  });
});
