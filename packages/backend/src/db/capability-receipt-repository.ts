/**
 * `clarity_capability_effect_receipts`: claim, complete, release, sweep.
 *
 * The claim is ONE `INSERT … ON CONFLICT DO NOTHING`, never a read followed by
 * a write: the unique key on (account, tool, key hash) decides which of two
 * concurrent calls with the same key runs the effect. The loser reads the
 * winner's row and gets one of three answers — a completed receipt to replay,
 * a claim still in flight, or a key that was used with other input. A receipt
 * past its `expires_at` that the sweep has not reaped yet is treated as absent.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, lte } from 'drizzle-orm';

import { getDb } from './index.js';
import { capabilityEffectReceipts } from './schema/index.js';

export type ReceiptClaim =
  | { readonly kind: 'claimed'; readonly id: string }
  | { readonly kind: 'replay'; readonly result: Record<string, unknown> }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'input_mismatch' };

export interface ReceiptKey {
  readonly oxyUserId: string;
  readonly tool: string;
  readonly idempotencyKeyHash: string;
}

export async function claimEffectReceipt(
  key: ReceiptKey & { readonly inputDigest: string; readonly expiresAt: Date },
): Promise<ReceiptClaim> {
  const db = getDb();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [claimed] = await db
      .insert(capabilityEffectReceipts)
      .values({ id: randomUUID(), ...key })
      .onConflictDoNothing()
      .returning({ id: capabilityEffectReceipts.id });
    if (claimed) return { kind: 'claimed', id: claimed.id };

    const [existing] = await db
      .select()
      .from(capabilityEffectReceipts)
      .where(
        and(
          eq(capabilityEffectReceipts.oxyUserId, key.oxyUserId),
          eq(capabilityEffectReceipts.tool, key.tool),
          eq(capabilityEffectReceipts.idempotencyKeyHash, key.idempotencyKeyHash),
        ),
      )
      .limit(1);
    // Released between our insert and this read: claim again.
    if (!existing) continue;
    if (existing.expiresAt.getTime() <= Date.now()) {
      await db
        .delete(capabilityEffectReceipts)
        .where(
          and(
            eq(capabilityEffectReceipts.id, existing.id),
            lte(capabilityEffectReceipts.expiresAt, new Date()),
          ),
        );
      continue;
    }
    if (existing.inputDigest !== key.inputDigest) return { kind: 'input_mismatch' };
    if (existing.status === 'completed' && existing.result !== null) {
      return { kind: 'replay', result: existing.result as Record<string, unknown> };
    }
    return { kind: 'in_progress' };
  }
  return { kind: 'in_progress' };
}

/** Record the effect's result on a claim this process holds. */
export async function completeEffectReceipt(
  id: string,
  result: Record<string, unknown>,
): Promise<void> {
  await getDb()
    .update(capabilityEffectReceipts)
    .set({ status: 'completed', result, completedAt: new Date() })
    .where(
      and(eq(capabilityEffectReceipts.id, id), eq(capabilityEffectReceipts.status, 'pending')),
    );
}

/** Drop a claim whose effect failed, so an honest retry can run it. */
export async function releaseEffectReceipt(id: string): Promise<void> {
  await getDb()
    .delete(capabilityEffectReceipts)
    .where(
      and(eq(capabilityEffectReceipts.id, id), eq(capabilityEffectReceipts.status, 'pending')),
    );
}

/** Delete every receipt past its retention (the worker's maintenance pass). */
export async function sweepExpiredEffectReceipts(now: Date = new Date()): Promise<number> {
  const removed = await getDb()
    .delete(capabilityEffectReceipts)
    .where(lte(capabilityEffectReceipts.expiresAt, now))
    .returning({ id: capabilityEffectReceipts.id });
  return removed.length;
}
