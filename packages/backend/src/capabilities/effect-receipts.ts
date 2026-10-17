/**
 * Run a tool's effect at most once per idempotency key.
 *
 * The first call claims a receipt, runs the effect and stores the result; a
 * retry with the same key and the same input gets that stored result back
 * without the effect running again. The same key with DIFFERENT input is
 * refused — a replayed answer to a question nobody asked is worse than an
 * error. A failed effect releases its claim so the caller may retry honestly;
 * a claim still in flight answers 409, because running a second concurrent
 * call would be the double effect this exists to prevent.
 */
import { createHash } from 'node:crypto';

import {
  claimEffectReceipt,
  completeEffectReceipt,
  releaseEffectReceipt,
} from '../db/capability-receipt-repository.js';
import { ToolError } from './handlers/context.js';

/** How long a receipt answers a retry; a retry is a matter of seconds to hours. */
export const EFFECT_RECEIPT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** JSON with object keys sorted at every depth, so equal inputs digest equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

export interface ReceiptScope {
  readonly accountId: string;
  readonly tool: string;
  readonly idempotencyKey: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export async function runWithEffectReceipt(
  scope: ReceiptScope,
  effect: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const claim = await claimEffectReceipt({
    oxyUserId: scope.accountId,
    tool: scope.tool,
    idempotencyKeyHash: sha256(scope.idempotencyKey),
    inputDigest: sha256(canonicalJson(scope.input)),
    expiresAt: new Date(Date.now() + EFFECT_RECEIPT_RETENTION_DAYS * DAY_MS),
  });
  if (claim.kind === 'replay') return claim.result;
  if (claim.kind === 'input_mismatch') {
    throw new ToolError(
      422,
      'idempotency_key_reused',
      'This idempotency key was already used with different input',
    );
  }
  if (claim.kind === 'in_progress') {
    throw new ToolError(
      409,
      'idempotency_in_progress',
      'A call with this idempotency key is still in progress',
    );
  }

  let result: Record<string, unknown>;
  try {
    result = await effect();
  } catch (error) {
    await releaseEffectReceipt(claim.id);
    throw error;
  }
  await completeEffectReceipt(claim.id, result);
  return result;
}
