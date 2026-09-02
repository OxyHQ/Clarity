import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { attestCutover } from '../attest-cutover.js';
import { runBackfill } from '../backfill.js';
import {
  LOCAL_TARGETS,
  canonicalJson,
  hashIdSet,
  inventoryPayload,
  sha256,
} from '../cutover-manifest.js';
import { closePostgres, connectPostgres } from '../index.js';
import {
  countMessages,
  deleteConversation,
  findConversation,
  listMessages,
  replaceConversation,
} from '../chat-repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const workspace = mkdtempSync(join(tmpdir(), 'clarity-pg-cutover-'));
const manifestPath = join(workspace, 'manifest.json');
const badManifestPath = join(workspace, 'bad-manifest.json');
const agentId = 'provisioned-test-agent';
let snapshotHash = '';

function sourceRow(id: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    _id: id,
    ...fields,
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  };
}

function writeManifest(): void {
  const rows: Partial<Record<(typeof LOCAL_TARGETS)[number], Record<string, unknown>[]>> = {
    clarity_conversations: [sourceRow('conversation-row', {
      oxyUserId: 'user-1',
      conversationId: 'conversation-1',
      title: 'Imported',
      source: 'app',
      createdAt: { $date: { $numberLong: '1788307200000' } },
      updatedAt: { $date: { $numberLong: '1788307200000' } },
    })],
    clarity_messages: [sourceRow('message-row', {
      id: 'message-1',
      oxyUserId: 'user-1',
      conversationId: 'conversation-1',
      role: 'user',
      content: 'hello',
    })],
    clarity_suggestions: [sourceRow('suggestion-row', {
      suggestionId: 'suggestion-1',
      title: 'Imported suggestion',
      text: 'Try this',
      type: 'welcome',
      usageCount: { $numberInt: '3' },
      priority: { $numberLong: '9' },
    })],
    clarity_plans: [sourceRow('plan-row', {
      planId: 'clarity-test-plan',
      name: 'Test plan',
      product: 'clarity',
      modelIds: ['clarity-v1'],
    })],
    clarity_features: [sourceRow('feature-row', {
      featureId: 'feature-test',
      label: 'Test feature',
      category: 'Core',
    })],
    clarity_plan_features: [sourceRow('plan-feature-row', {
      planId: 'clarity-test-plan',
      featureId: 'feature-test',
    })],
  };
  delete rows.clarity_messages?.[0]?.updatedAt;
  const collections = LOCAL_TARGETS.map((targetTable) => {
    const targetRows = rows[targetTable] ?? [];
    const content = targetRows.map((row) => JSON.stringify(row)).join('\n')
      + (targetRows.length > 0 ? '\n' : '');
    const dataFile = `${targetTable}.jsonl`;
    writeFileSync(join(workspace, dataFile), content);
    return {
      sourceName: `source_${targetTable}`,
      sourceCount: targetRows.length,
      sourceIdSha256: hashIdSet(targetRows.map((row) => String(row._id))),
      disposition: {
        kind: 'clarity-postgres' as const,
        targetTable,
        dataFile,
        dataBytes: Buffer.byteLength(content),
        dataSha256: sha256(content),
      },
    };
  });
  const manifest = {
    schemaVersion: 1 as const,
    snapshot: {
      id: 'integration-snapshot',
      sourceDatabase: 'integration-source',
      exportedAt: '2026-09-02T00:00:00.000Z',
      collectionCount: collections.length,
      inventorySha256: '',
    },
    collections,
    runtimeEvidence: {
      aliaAgentIdSha256: sha256(agentId),
      aliaAgentChat: { receiptId: 'chat-ok', verifiedAt: '2026-09-02T00:00:00.000Z' },
      oxyInference: { receiptId: 'oxy-ok', verifiedAt: '2026-09-02T00:00:00.000Z' },
      kaanaRoute: { receiptId: 'kaana-ok', verifiedAt: '2026-09-02T00:00:00.000Z' },
      billingCreditGrant: { receiptId: 'billing-ok', verifiedAt: '2026-09-02T00:00:00.000Z' },
    },
  };
  snapshotHash = sha256(canonicalJson(inventoryPayload(manifest as never)));
  manifest.snapshot.inventorySha256 = snapshotHash;
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

suite('PostgreSQL backfill and repository integration', () => {
  beforeAll(async () => {
    const databaseName = new URL(databaseUrl!).pathname.slice(1);
    if (databaseName !== 'clarity_ci') throw new Error('integration tests require database clarity_ci');
    const sql = postgres(databaseUrl!, { max: 1 });
    await sql.unsafe(`truncate table
      clarity_backfill_receipts,
      clarity_messages,
      clarity_conversations,
      clarity_suggestions,
      clarity_plan_features,
      clarity_features,
      clarity_plans,
      clarity_credit_packages,
      clarity_feedback,
      clarity_notifications,
      clarity_push_tokens,
      clarity_web_push_subscriptions,
      clarity_subscriptions,
      clarity_billing_customers,
      clarity_runtime_state
      cascade`);
    await sql.end();
    writeManifest();
  });

  afterAll(async () => {
    await closePostgres();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('rolls back a collection when the bytes read do not match the manifest', async () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const suggestion = manifest.collections.find((item: { disposition?: { targetTable?: string } }) => (
      item.disposition?.targetTable === 'clarity_suggestions'
    ));
    suggestion.disposition.dataSha256 = '0'.repeat(64);
    writeFileSync(badManifestPath, JSON.stringify(manifest));

    await expect(runBackfill(badManifestPath, databaseUrl!)).rejects.toThrow('data hash changed');

    const sql = postgres(databaseUrl!, { max: 1 });
    const [suggestionCount] = await sql<{ count: number }[]>`
      select count(*)::int as count from clarity_suggestions
    `;
    const [receiptCount] = await sql<{ count: number }[]>`
      select count(*)::int as count from clarity_backfill_receipts
      where source_collection = 'source_clarity_suggestions'
    `;
    await sql.end();
    expect(suggestionCount?.count).toBe(0);
    expect(receiptCount?.count).toBe(0);
  });

  it('imports exact IDs, reruns idempotently, and requires explicit cutover evidence', async () => {
    await runBackfill(manifestPath, databaseUrl!);
    await runBackfill(manifestPath, databaseUrl!);
    await expect(attestCutover({
      databaseUrl: databaseUrl!,
      manifestPath,
      expectedSnapshotHash: snapshotHash,
      confirmation: 'CUTOVER_CLARITY_TO_POSTGRES',
      agentId: 'wrong-agent',
    })).rejects.toThrow('does not match runtime evidence');
    await attestCutover({
      databaseUrl: databaseUrl!,
      manifestPath,
      expectedSnapshotHash: snapshotHash,
      confirmation: 'CUTOVER_CLARITY_TO_POSTGRES',
      agentId,
    });

    const sql = postgres(databaseUrl!, { max: 1 });
    const [mapping] = await sql<{ id: string }[]>`
      select id from clarity_plan_features
      where plan_id = 'clarity-test-plan' and feature_id = 'feature-test'
    `;
    await sql.end();
    expect(mapping?.id).toBe('plan-feature-row');

    connectPostgres(databaseUrl);
    expect((await findConversation('user-1', 'conversation-1'))?.id).toBe('conversation-row');
    expect((await listMessages('user-1', 'conversation-1'))[0]?.id).toBe('message-row');
  });

  it('rolls back metadata and message replacement together, then cascades deletes', async () => {
    await expect(replaceConversation({
      oxyUserId: 'user-1',
      conversationId: 'conversation-1',
      title: 'Must roll back',
      titleOnInsert: 'unused',
      messages: [{ role: 'invalid' as 'user', content: 'bad' }],
    })).rejects.toThrow();
    expect((await findConversation('user-1', 'conversation-1'))?.title).toBe('Imported');
    expect(await countMessages('user-1', 'conversation-1')).toBe(1);

    expect(await deleteConversation('user-1', 'conversation-1')).toBe(true);
    expect(await countMessages('user-1', 'conversation-1')).toBe(0);
  });
});
