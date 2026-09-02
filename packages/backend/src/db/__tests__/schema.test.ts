import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  backfillReceipts,
  conversations,
  messages,
  planFeatures,
  suggestions,
} from '../schema/index.js';

describe('PostgreSQL expand schema', () => {
  it('preserves source and product IDs as distinct text columns', () => {
    const conversationColumns = getTableConfig(conversations).columns.map((column) => column.name);
    const messageColumns = getTableConfig(messages).columns.map((column) => column.name);
    const planFeatureColumns = getTableConfig(planFeatures).columns.map((column) => column.name);
    expect(conversationColumns).toEqual(expect.arrayContaining(['id', 'conversation_id', 'oxy_user_id']));
    expect(messageColumns).toEqual(expect.arrayContaining(['id', 'message_id', 'conversation_id', 'oxy_user_id']));
    expect(planFeatureColumns).toEqual(expect.arrayContaining(['id', 'plan_id', 'feature_id']));
  });

  it('ports the query indexes that cannot be proven by functional tests', () => {
    const conversationIndexes = getTableConfig(conversations).indexes.map((item) => item.config.name);
    const messageIndexes = getTableConfig(messages).indexes.map((item) => item.config.name);
    const suggestionIndexes = getTableConfig(suggestions).indexes.map((item) => item.config.name);
    expect(conversationIndexes).toEqual(expect.arrayContaining([
      'clarity_conversations_user_updated_idx',
      'clarity_conversations_user_agent_idx',
    ]));
    expect(messageIndexes).toEqual(expect.arrayContaining([
      'clarity_messages_conversation_created_idx',
      'clarity_messages_user_conversation_idx',
    ]));
    expect(suggestionIndexes).toEqual(expect.arrayContaining([
      'clarity_suggestions_trigger_words_idx',
      'clarity_suggestions_text_search_idx',
    ]));
  });

  it('makes backfill receipts unique by source collection and exact source ID', () => {
    const config = getTableConfig(backfillReceipts);
    expect(config.primaryKeys).toHaveLength(1);
    expect(config.primaryKeys[0].columns.map((column) => column.name))
      .toEqual(['source_collection', 'source_id']);
  });
});
