import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';

export const LOCAL_TARGETS = [
  'clarity_conversations',
  'clarity_messages',
  'clarity_suggestions',
  'clarity_plans',
  'clarity_features',
  'clarity_plan_features',
  'clarity_credit_packages',
  'clarity_feedback',
  'clarity_notifications',
  'clarity_push_tokens',
  'clarity_web_push_subscriptions',
  'clarity_subscriptions',
] as const;

export type LocalTarget = (typeof LOCAL_TARGETS)[number];

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z.object({
  receiptId: z.string().min(1).max(500),
  completedAt: z.iso.datetime({ offset: true }),
  targetCount: z.number().int().nonnegative(),
  targetIdSha256: sha256Schema,
});

const localDispositionSchema = z.object({
  kind: z.literal('clarity-postgres'),
  targetTable: z.enum(LOCAL_TARGETS),
  dataFile: z.string().min(1).max(500),
  dataBytes: z.number().int().nonnegative().max(2_147_483_648),
  dataSha256: sha256Schema,
});

const externalDispositionSchema = z.object({
  kind: z.literal('external'),
  target: z.enum(['alia', 'kaana', 'oxy', 'archive']),
  receipt: receiptSchema,
});

const collectionSchema = z.object({
  sourceName: z.string().min(1).max(200),
  sourceCount: z.number().int().nonnegative(),
  sourceIdSha256: sha256Schema,
  disposition: z.discriminatedUnion('kind', [
    localDispositionSchema,
    externalDispositionSchema,
  ]),
});

const runtimeReceiptSchema = z.object({
  receiptId: z.string().min(1).max(500),
  verifiedAt: z.iso.datetime({ offset: true }),
});

export const cutoverManifestSchema = z.object({
  schemaVersion: z.literal(1),
  snapshot: z.object({
    id: z.string().min(1).max(200),
    sourceDatabase: z.string().min(1).max(200),
    exportedAt: z.iso.datetime({ offset: true }),
    collectionCount: z.number().int().positive(),
    inventorySha256: sha256Schema,
  }),
  collections: z.array(collectionSchema).min(1),
  runtimeEvidence: z.object({
    aliaAgentIdSha256: sha256Schema,
    aliaAgentChat: runtimeReceiptSchema,
    oxyInference: runtimeReceiptSchema,
    kaanaRoute: runtimeReceiptSchema,
    billingCreditGrant: runtimeReceiptSchema,
  }),
});

export type CutoverManifest = z.infer<typeof cutoverManifestSchema>;
export type CutoverCollection = CutoverManifest['collections'][number];

export const EMPTY_ID_SET_SHA256 = sha256('');

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  )).join(',')}}`;
}

export function hashIdSet(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  if (new Set(sorted).size !== sorted.length) throw new Error('duplicate source IDs');
  return sha256(sorted.join('\n'));
}

export function inventoryPayload(manifest: CutoverManifest): unknown {
  return {
    snapshotId: manifest.snapshot.id,
    sourceDatabase: manifest.snapshot.sourceDatabase,
    exportedAt: manifest.snapshot.exportedAt,
    collections: manifest.collections
      .map(({ sourceName, sourceCount, sourceIdSha256 }) => ({
        sourceName,
        sourceCount,
        sourceIdSha256,
      }))
      .sort((left, right) => left.sourceName.localeCompare(right.sourceName)),
  };
}

export function validateCutoverManifest(value: unknown): CutoverManifest {
  const manifest = cutoverManifestSchema.parse(value);
  const exportedAt = Date.parse(manifest.snapshot.exportedAt);
  if (manifest.snapshot.collectionCount !== manifest.collections.length) {
    throw new Error('snapshot collectionCount does not match the inventory');
  }

  const sourceNames = manifest.collections.map((item) => item.sourceName);
  if (new Set(sourceNames).size !== sourceNames.length) {
    throw new Error('source collection names must be unique');
  }

  const local = manifest.collections.filter((item) => (
    item.disposition.kind === 'clarity-postgres'
  ));
  const localTargets = local.map((item) => (
    item.disposition.kind === 'clarity-postgres' ? item.disposition.targetTable : ''
  ));
  if (new Set(localTargets).size !== localTargets.length) {
    throw new Error('each Clarity target table must have one source collection');
  }
  const missingTargets = LOCAL_TARGETS.filter((target) => !localTargets.includes(target));
  if (missingTargets.length > 0) {
    throw new Error(`missing Clarity target collections: ${missingTargets.join(', ')}`);
  }

  for (const item of manifest.collections) {
    if (item.sourceCount === 0 && item.sourceIdSha256 !== EMPTY_ID_SET_SHA256) {
      throw new Error(`${item.sourceName} has a non-empty ID hash for zero rows`);
    }
    if (item.disposition.kind === 'external') {
      if (item.disposition.receipt.targetCount !== item.sourceCount) {
        throw new Error(`${item.sourceName} external count is not reconciled`);
      }
      if (item.disposition.receipt.targetIdSha256 !== item.sourceIdSha256) {
        throw new Error(`${item.sourceName} external ID set is not reconciled`);
      }
      if (Date.parse(item.disposition.receipt.completedAt) < exportedAt) {
        throw new Error(`${item.sourceName} external receipt predates the source snapshot`);
      }
    }
  }

  const runtimeReceipts = Object.values(manifest.runtimeEvidence)
    .filter((value): value is { receiptId: string; verifiedAt: string } => (
      typeof value === 'object' && value !== null && 'receiptId' in value && 'verifiedAt' in value
    ));
  const runtimeReceiptIds = runtimeReceipts.map((receipt) => receipt.receiptId);
  if (new Set(runtimeReceiptIds).size !== runtimeReceiptIds.length) {
    throw new Error('runtime evidence receipt IDs must be unique');
  }
  for (const receipt of runtimeReceipts) {
    if (Date.parse(receipt.verifiedAt) < exportedAt) {
      throw new Error(`${receipt.receiptId} runtime evidence predates the source snapshot`);
    }
  }

  const actualInventoryHash = sha256(canonicalJson(inventoryPayload(manifest)));
  if (actualInventoryHash !== manifest.snapshot.inventorySha256) {
    throw new Error('snapshot inventory hash does not match its collection inventory');
  }
  return manifest;
}

export function readCutoverManifest(path: string): CutoverManifest {
  const size = statSync(path).size;
  if (size > 1_048_576) throw new Error('cutover manifest exceeds 1 MiB');
  return validateCutoverManifest(JSON.parse(readFileSync(path, 'utf8')));
}

export function resolveDataFile(manifestPath: string, dataFile: string): string {
  if (isAbsolute(dataFile)) throw new Error('dataFile must be relative to the manifest');
  const root = realpathSync(resolve(dirname(manifestPath)));
  const file = realpathSync(resolve(root, dataFile));
  const fromRoot = relative(root, file);
  if (fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('dataFile escapes the manifest directory');
  }
  return file;
}

export function sourceId(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const oid = (value as Record<string, unknown>).$oid;
    if (typeof oid === 'string' && oid.length > 0) return oid;
  }
  throw new Error('source record has no valid _id');
}
