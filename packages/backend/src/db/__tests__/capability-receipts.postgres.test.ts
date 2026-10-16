/**
 * `clarity_capability_effect_receipts` against PostgreSQL: one claim per
 * (account, tool, key), a replay of the stored answer, a refusal for reused
 * keys with other input, release of a failed claim, the retention sweep, and
 * erasure with the account.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runWithEffectReceipt } from '../../capabilities/effect-receipts.js';
import {
  claimEffectReceipt,
  sweepExpiredEffectReceipts,
} from '../capability-receipt-repository.js';
import { eraseDeletedAccountExperience } from '../experience-repository.js';
import { closePostgres, connectPostgres, getDb } from '../index.js';
import { capabilityEffectReceipts } from '../schema/index.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
if (databaseUrl && new URL(databaseUrl).pathname !== '/clarity_ci')
  throw new Error('Use only clarity_ci');
const suite = databaseUrl ? describe : describe.skip;

suite('capability effect receipts', () => {
  beforeAll(() => {
    connectPostgres(databaseUrl);
  });
  afterAll(async () => {
    await closePostgres();
  });

  it('runs an effect once per key and replays its answer', async () => {
    const accountId = `receipts-${randomUUID()}`;
    let runs = 0;
    const effect = async () => {
      runs += 1;
      return { id: `effect-${runs}` };
    };
    const scope = { accountId, tool: 'submitFeedback', idempotencyKey: 'k-1', input: { a: 1 } };
    expect(await runWithEffectReceipt(scope, effect)).toEqual({ id: 'effect-1' });
    expect(await runWithEffectReceipt({ ...scope, input: { a: 1 } }, effect)).toEqual({
      id: 'effect-1',
    });
    expect(runs).toBe(1);

    await expect(runWithEffectReceipt({ ...scope, input: { a: 2 } }, effect)).rejects.toMatchObject(
      { code: 'idempotency_key_reused', status: 422 },
    );
    // The same key is another receipt for another tool or another account.
    await runWithEffectReceipt({ ...scope, tool: 'addExperience' }, effect);
    await runWithEffectReceipt({ ...scope, accountId: `${accountId}-other` }, effect);
    expect(runs).toBe(3);
  });

  it('releases the claim of a failed effect so an honest retry runs', async () => {
    const scope = {
      accountId: `receipts-${randomUUID()}`,
      tool: 'reportJob',
      idempotencyKey: 'k-1',
      input: {},
    };
    await expect(
      runWithEffectReceipt(scope, async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect(await runWithEffectReceipt(scope, async () => ({ status: 'received' }))).toEqual({
      status: 'received',
    });
  });

  it('answers in-progress to a second claim while the first holds the key', async () => {
    const key = {
      oxyUserId: `receipts-${randomUUID()}`,
      tool: 'submitFeedback',
      idempotencyKeyHash: 'a'.repeat(64),
      inputDigest: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    };
    expect((await claimEffectReceipt(key)).kind).toBe('claimed');
    expect(await claimEffectReceipt(key)).toEqual({ kind: 'in_progress' });
  });

  it('sweeps expired receipts and erases them with a deleted account', async () => {
    const expired = `receipts-${randomUUID()}`;
    await claimEffectReceipt({
      oxyUserId: expired,
      tool: 'submitFeedback',
      idempotencyKeyHash: 'c'.repeat(64),
      inputDigest: 'd'.repeat(64),
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await sweepExpiredEffectReceipts()).toBeGreaterThanOrEqual(1);
    const left = await getDb()
      .select()
      .from(capabilityEffectReceipts)
      .where(eq(capabilityEffectReceipts.oxyUserId, expired));
    expect(left).toEqual([]);

    const deleted = `receipts-${randomUUID()}`;
    await runWithEffectReceipt(
      { accountId: deleted, tool: 'addExperience', idempotencyKey: 'k', input: {} },
      async () => ({ id: 'entry' }),
    );
    await eraseDeletedAccountExperience(deleted, `event-${randomUUID()}`);
    const erased = await getDb()
      .select()
      .from(capabilityEffectReceipts)
      .where(eq(capabilityEffectReceipts.oxyUserId, deleted));
    expect(erased).toEqual([]);
  });
});
