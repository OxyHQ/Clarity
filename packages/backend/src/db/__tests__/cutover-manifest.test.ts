import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_ID_SET_SHA256,
  LOCAL_TARGETS,
  canonicalJson,
  inventoryPayload,
  resolveDataFile,
  sha256,
  validateCutoverManifest,
  type CutoverManifest,
} from '../cutover-manifest.js';

function validManifest(): CutoverManifest {
  const collections: CutoverManifest['collections'] = LOCAL_TARGETS.map((targetTable) => ({
    sourceName: `source_${targetTable}`,
    sourceCount: 0,
    sourceIdSha256: EMPTY_ID_SET_SHA256,
    disposition: {
      kind: 'clarity-postgres' as const,
      targetTable,
      dataFile: `${targetTable}.jsonl`,
      dataBytes: 0,
      dataSha256: sha256(''),
    },
  }));
  collections.push({
    sourceName: 'source_conversations',
    sourceCount: 2,
    sourceIdSha256: sha256('conversation-1\nconversation-2'),
    disposition: { kind: 'discarded' as const },
  });
  collections.push({
    sourceName: 'source_external_history',
    sourceCount: 0,
    sourceIdSha256: EMPTY_ID_SET_SHA256,
    disposition: {
      kind: 'external' as const,
      target: 'archive' as const,
      receipt: {
        receiptId: 'archive-receipt',
        completedAt: '2026-09-02T00:00:00.000Z',
        targetCount: 0,
        targetIdSha256: EMPTY_ID_SET_SHA256,
      },
    },
  });
  const manifest: CutoverManifest = {
    schemaVersion: 1 as const,
    snapshot: {
      id: 'snapshot-1',
      sourceDatabase: 'legacy-clarity',
      exportedAt: '2026-09-02T00:00:00.000Z',
      collectionCount: collections.length,
      inventorySha256: '',
    },
    collections,
  };
  manifest.snapshot.inventorySha256 = sha256(canonicalJson(inventoryPayload(manifest)));
  return manifest;
}

describe('cutover manifest', () => {
  it('requires every local target exactly once and a content-bound inventory', () => {
    expect(validateCutoverManifest(validManifest()).collections).toHaveLength(
      LOCAL_TARGETS.length + 2,
    );

    const missing = validManifest();
    missing.collections.splice(0, 1);
    missing.snapshot.collectionCount -= 1;
    missing.snapshot.inventorySha256 = sha256(canonicalJson(inventoryPayload(missing)));
    expect(() => validateCutoverManifest(missing)).toThrow('missing Clarity target');
  });

  it('rejects counts-only external receipts with a different ID set', () => {
    const manifest = validManifest();
    const external = manifest.collections.at(-1)!;
    external.sourceCount = 1;
    external.sourceIdSha256 = sha256('source-id');
    if (external.disposition.kind === 'external') {
      external.disposition.receipt.targetCount = 1;
      external.disposition.receipt.targetIdSha256 = sha256('different-id');
    }
    manifest.snapshot.inventorySha256 = sha256(canonicalJson(inventoryPayload(manifest)));
    expect(() => validateCutoverManifest(manifest)).toThrow('external ID set is not reconciled');
  });

  it('rejects duplicate source names', () => {
    const manifest = validManifest();
    manifest.collections[1]!.sourceName = manifest.collections[0]!.sourceName;
    manifest.snapshot.inventorySha256 = sha256(canonicalJson(inventoryPayload(manifest)));
    expect(() => validateCutoverManifest(manifest)).toThrow(
      'source collection names must be unique',
    );
  });

  it('rejects external receipts completed before the fixed source snapshot', () => {
    const manifest = validManifest();
    const external = manifest.collections.at(-1)!;
    if (external.disposition.kind === 'external') {
      external.disposition.receipt.completedAt = '2026-09-01T23:59:59.999Z';
    }
    expect(() => validateCutoverManifest(manifest)).toThrow('predates the source snapshot');
  });

  it('counts a discarded collection in the inventory without a Clarity target', () => {
    const manifest = validManifest();
    expect(LOCAL_TARGETS).not.toContain('clarity_conversations');
    expect(LOCAL_TARGETS).not.toContain('clarity_messages');
    const discarded = manifest.collections.find((item) => item.disposition.kind === 'discarded');
    expect(discarded?.sourceCount).toBe(2);
    discarded!.sourceCount = 3;
    expect(() => validateCutoverManifest(manifest)).toThrow('inventory hash does not match');
  });

  it('rejects data files that escape through a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'clarity-manifest-path-'));
    const outside = mkdtempSync(join(tmpdir(), 'clarity-manifest-outside-'));
    try {
      const manifestPath = join(root, 'manifest.json');
      writeFileSync(manifestPath, '{}');
      writeFileSync(join(outside, 'data.jsonl'), '{}\n');
      symlinkSync(join(outside, 'data.jsonl'), join(root, 'data.jsonl'));
      expect(() => resolveDataFile(manifestPath, 'data.jsonl')).toThrow(
        'escapes the manifest directory',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
