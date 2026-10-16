import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as schema from '../schema/index.js';
import {
  backfillReceipts,
  capabilityEffectReceipts,
  planFeatures,
  plans,
  runtimeState,
  suggestions,
} from '../schema/index.js';

describe('PostgreSQL schema', () => {
  it('preserves source and product IDs as distinct text columns', () => {
    const planFeatureColumns = getTableConfig(planFeatures).columns.map((column) => column.name);
    expect(planFeatureColumns).toEqual(expect.arrayContaining(['id', 'plan_id', 'feature_id']));
  });

  it('ports the query indexes that cannot be proven by functional tests', () => {
    const suggestionIndexes = getTableConfig(suggestions).indexes.map((item) => item.config.name);
    expect(suggestionIndexes).toEqual(
      expect.arrayContaining([
        'clarity_suggestions_trigger_words_idx',
        'clarity_suggestions_text_search_idx',
      ]),
    );
  });

  it('makes backfill receipts unique by source collection and exact source ID', () => {
    const config = getTableConfig(backfillReceipts);
    expect(config.primaryKeys).toHaveLength(1);
    expect(config.primaryKeys[0].columns.map((column) => column.name)).toEqual([
      'source_collection',
      'source_id',
    ]);
  });

  it('claims one capability effect per account, tool and idempotency key', () => {
    const config = getTableConfig(capabilityEffectReceipts);
    expect(
      config.uniqueConstraints.map((item) => item.columns.map((column) => column.name)),
    ).toEqual([['oxy_user_id', 'tool', 'idempotency_key_hash']]);
    expect(config.columns.map((column) => column.name)).not.toContain('idempotency_key');
  });

  it('holds no chat history, model id or agent pin (owner decision 2026-10-16)', () => {
    const tables = Object.values(schema)
      .filter(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          Symbol.for('drizzle:IsDrizzleTable') in value,
      )
      .map((table) => getTableConfig(table as typeof plans).name);
    expect(tables).not.toContain('clarity_conversations');
    expect(tables).not.toContain('clarity_messages');
    expect(getTableConfig(plans).columns.map((column) => column.name)).not.toContain('model_ids');
    expect(getTableConfig(runtimeState).columns.map((column) => column.name)).not.toContain(
      'alia_agent_id_sha256',
    );
  });
});
