import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

const timestampColumns = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const conversations = pgTable('clarity_conversations', {
  /** Exact legacy source `_id`; backfill never generates a replacement. */
  id: text('id').primaryKey(),
  oxyUserId: text('oxy_user_id').notNull(),
  conversationId: text('conversation_id').notNull(),
  title: text('title').notNull().default('New chat'),
  isManualTitle: boolean('is_manual_title').notNull().default(false),
  lastMessage: text('last_message'),
  source: text('source').notNull().default('app'),
  folderId: text('folder_id'),
  icon: text('icon'),
  iconColor: text('icon_color'),
  isFavorite: boolean('is_favorite').notNull().default(false),
  isPublic: boolean('is_public').notNull().default(false),
  ...timestampColumns(),
}, (table) => [
  unique('clarity_conversations_user_conversation_unique')
    .on(table.oxyUserId, table.conversationId),
  index('clarity_conversations_user_updated_idx')
    .on(table.oxyUserId, table.updatedAt),
  check(
    'clarity_conversations_source_check',
    sql`${table.source} in ('app', 'telegram', 'api', 'web', 'discord', 'whatsapp', 'slack')`,
  ),
]);

export const messages = pgTable('clarity_messages', {
  /** Exact legacy source `_id`; distinct from the optional product message ID. */
  id: text('id').primaryKey(),
  messageId: text('message_id'),
  oxyUserId: text('oxy_user_id').notNull(),
  conversationId: text('conversation_id').notNull(),
  role: text('role').notNull(),
  content: jsonb('content').notNull(),
  vote: text('vote'),
  toolInvocations: jsonb('tool_invocations').notNull().default(sql`'[]'::jsonb`),
  audioUrl: text('audio_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    name: 'clarity_messages_conversation_fk',
    columns: [table.oxyUserId, table.conversationId],
    foreignColumns: [conversations.oxyUserId, conversations.conversationId],
  }).onDelete('cascade'),
  index('clarity_messages_conversation_created_idx')
    .on(table.conversationId, table.createdAt),
  index('clarity_messages_user_conversation_idx')
    .on(table.oxyUserId, table.conversationId),
  check('clarity_messages_role_check', sql`${table.role} in ('user', 'assistant', 'system')`),
  check('clarity_messages_vote_check', sql`${table.vote} is null or ${table.vote} in ('up', 'down')`),
]);

export const suggestions = pgTable('clarity_suggestions', {
  /** Exact legacy source `_id`. */
  id: text('id').primaryKey(),
  suggestionId: text('suggestion_id').notNull().unique(),
  title: text('title').notNull(),
  text: text('text').notNull(),
  description: text('description'),
  isTemplate: boolean('is_template').notNull().default(false),
  templateVariables: text('template_variables').array().notNull().default(sql`'{}'::text[]`),
  type: text('type').notNull(),
  category: text('category'),
  triggerWords: text('trigger_words').array().notNull().default(sql`'{}'::text[]`),
  scope: text('scope').notNull().default('global'),
  oxyUserId: text('oxy_user_id'),
  language: text('language').notNull().default('en-US'),
  usageCount: integer('usage_count').notNull().default(0),
  priority: integer('priority').notNull().default(0),
  isBuiltIn: boolean('is_built_in').notNull().default(false),
  isAiGenerated: boolean('is_ai_generated').notNull().default(false),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  occupations: text('occupations').array().notNull().default(sql`'{}'::text[]`),
  interests: text('interests').array().notNull().default(sql`'{}'::text[]`),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  ...timestampColumns(),
}, (table) => [
  index('clarity_suggestions_scope_language_type_idx')
    .on(table.scope, table.language, table.type),
  index('clarity_suggestions_user_scope_idx').on(table.oxyUserId, table.scope),
  index('clarity_suggestions_expires_idx').on(table.expiresAt),
  index('clarity_suggestions_trigger_words_idx').using('gin', table.triggerWords),
  index('clarity_suggestions_text_search_idx').using(
    'gin',
    sql`to_tsvector('simple', coalesce(${table.title}, '') || ' ' || coalesce(${table.text}, ''))`,
  ),
  check('clarity_suggestions_type_check', sql`${table.type} in ('welcome', 'autocomplete')`),
  check('clarity_suggestions_scope_check', sql`${table.scope} in ('global', 'personal')`),
  check('clarity_suggestions_usage_count_check', sql`${table.usageCount} >= 0`),
]);

export const plans = pgTable('clarity_plans', {
  /** Exact legacy source `_id`. */
  id: text('id').primaryKey(),
  planId: text('plan_id').notNull().unique(),
  name: text('name').notNull(),
  product: text('product').notNull(),
  creditsPerMonth: integer('credits_per_month').notNull().default(0),
  dailyFreeCredits: integer('daily_free_credits').notNull().default(300),
  monthlyPrice: integer('monthly_price').notNull().default(0),
  annualPrice: integer('annual_price').notNull().default(0),
  currency: text('currency').notNull().default('usd'),
  subtitle: text('subtitle').notNull().default(''),
  creditsLabel: text('credits_label').notNull().default(''),
  isFeatured: boolean('is_featured').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  modelIds: text('model_ids').array().notNull().default(sql`'{}'::text[]`),
  isActive: boolean('is_active').notNull().default(true),
  isFree: boolean('is_free').notNull().default(false),
  stripeProductId: text('stripe_product_id'),
  stripeMonthlyPriceId: text('stripe_monthly_price_id'),
  stripeAnnualPriceId: text('stripe_annual_price_id'),
  description: text('description'),
  notes: text('notes'),
  ...timestampColumns(),
}, (table) => [
  index('clarity_plans_product_sort_idx').on(table.product, table.sortOrder),
  index('clarity_plans_product_active_idx').on(table.product, table.isActive),
  check('clarity_plans_product_check', sql`${table.product} in ('clarity', 'codea')`),
  check('clarity_plans_prices_check', sql`${table.monthlyPrice} >= 0 and ${table.annualPrice} >= 0`),
]);

export const features = pgTable('clarity_features', {
  /** Exact legacy source `_id`. */
  id: text('id').primaryKey(),
  featureId: text('feature_id').notNull().unique(),
  label: text('label').notNull(),
  description: text('description'),
  icon: text('icon'),
  category: text('category').notNull(),
  featureType: text('feature_type').notNull().default('boolean'),
  sortOrder: integer('sort_order').notNull().default(0),
  isVisibleOnPricing: boolean('is_visible_on_pricing').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  ...timestampColumns(),
}, (table) => [
  index('clarity_features_category_sort_idx').on(table.category, table.sortOrder),
  check('clarity_features_type_check', sql`${table.featureType} in ('boolean', 'limit')`),
]);

export const planFeatures = pgTable('clarity_plan_features', {
  /** Exact legacy source `_id`; product joins continue to use exact plan/feature IDs. */
  id: text('id').notNull().unique(),
  planId: text('plan_id').notNull(),
  featureId: text('feature_id').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  limitValue: integer('limit_value'),
  displayLabel: text('display_label'),
  displayDescription: text('display_description'),
  ...timestampColumns(),
}, (table) => [
  primaryKey({ name: 'clarity_plan_features_pk', columns: [table.planId, table.featureId] }),
  foreignKey({
    name: 'clarity_plan_features_plan_fk',
    columns: [table.planId],
    foreignColumns: [plans.planId],
  }).onDelete('cascade'),
  foreignKey({
    name: 'clarity_plan_features_feature_fk',
    columns: [table.featureId],
    foreignColumns: [features.featureId],
  }).onDelete('cascade'),
  index('clarity_plan_features_feature_idx').on(table.featureId),
]);

/**
 * Legacy product catalogue data retained for lossless cutover reconciliation.
 * Live inference-credit offers are read from Alia; Clarity never mutates this
 * table after import and can retire it only after an operator-approved archive.
 */
export const creditPackages = pgTable('clarity_credit_packages', {
  id: text('id').primaryKey(),
  packageId: text('package_id').notNull().unique(),
  name: text('name').notNull(),
  credits: integer('credits').notNull(),
  price: integer('price').notNull(),
  currency: text('currency').notNull().default('usd'),
  stripePriceId: text('stripe_price_id'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  description: text('description'),
  ...timestampColumns(),
}, (table) => [
  index('clarity_credit_packages_active_sort_idx').on(table.isActive, table.sortOrder),
  check('clarity_credit_packages_credits_check', sql`${table.credits} > 0`),
  check('clarity_credit_packages_price_check', sql`${table.price} >= 0`),
]);

export const feedback = pgTable('clarity_feedback', {
  /** Exact legacy source `_id` for imported rows; UUID text for new rows. */
  id: text('id').primaryKey(),
  oxyUserId: text('oxy_user_id').notNull(),
  type: text('type').notNull(),
  rating: integer('rating'),
  message: text('message').notNull(),
  email: text('email'),
  metadata: jsonb('metadata'),
  status: text('status').notNull().default('pending'),
  ...timestampColumns(),
}, (table) => [
  index('clarity_feedback_user_created_idx').on(table.oxyUserId, table.createdAt),
  index('clarity_feedback_status_idx').on(table.status),
  index('clarity_feedback_type_idx').on(table.type),
  check('clarity_feedback_type_check', sql`${table.type} in ('bug', 'feature', 'improvement', 'other')`),
  check('clarity_feedback_status_check', sql`${table.status} in ('pending', 'reviewed', 'resolved')`),
  check('clarity_feedback_rating_check', sql`${table.rating} is null or ${table.rating} between 1 and 5`),
]);

export const notifications = pgTable('clarity_notifications', {
  id: text('id').primaryKey(),
  oxyUserId: text('oxy_user_id').notNull(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  data: jsonb('data'),
  channels: text('channels').array().notNull().default(sql`'{}'::text[]`),
  deliveryStatus: jsonb('delivery_status').notNull().default(sql`'{}'::jsonb`),
  status: text('status').notNull().default('pending'),
  priority: text('priority').notNull().default('normal'),
  triggerId: text('trigger_id'),
  conversationId: text('conversation_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  readAt: timestamp('read_at', { withTimezone: true }),
  ...timestampColumns(),
}, (table) => [
  index('clarity_notifications_user_status_created_idx')
    .on(table.oxyUserId, table.status, table.createdAt),
  index('clarity_notifications_expires_idx').on(table.expiresAt),
  check(
    'clarity_notifications_type_check',
    sql`${table.type} in ('trigger_result', 'proactive_insight', 'daily_briefing', 'price_alert', 'integration_event', 'reminder', 'agent_task_complete', 'chat_response_ready', 'oxy_service')`,
  ),
  check('clarity_notifications_status_check', sql`${table.status} in ('pending', 'sent', 'read', 'dismissed')`),
  check('clarity_notifications_priority_check', sql`${table.priority} in ('low', 'normal', 'high', 'urgent')`),
]);

export const pushTokens = pgTable('clarity_push_tokens', {
  id: text('id').primaryKey(),
  oxyUserId: text('oxy_user_id').notNull(),
  token: text('token').notNull(),
  deviceId: text('device_id'),
  platform: text('platform'),
  active: boolean('active').notNull().default(true),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  ...timestampColumns(),
}, (table) => [
  unique('clarity_push_tokens_user_token_unique').on(table.oxyUserId, table.token),
  index('clarity_push_tokens_token_idx').on(table.token),
  check('clarity_push_tokens_platform_check', sql`${table.platform} is null or ${table.platform} in ('ios', 'android', 'web')`),
]);

export const webPushSubscriptions = pgTable('clarity_web_push_subscriptions', {
  id: text('id').primaryKey(),
  oxyUserId: text('oxy_user_id').notNull(),
  endpoint: text('endpoint').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  active: boolean('active').notNull().default(true),
  ...timestampColumns(),
}, (table) => [
  unique('clarity_web_push_user_endpoint_unique').on(table.oxyUserId, table.endpoint),
]);

/** Clarity product membership only. Inference credits and usage are owned by Alia. */
export const subscriptions = pgTable('clarity_subscriptions', {
  /** Exact legacy source `_id` for imported rows. */
  id: text('id').primaryKey(),
  oxyUserId: text('oxy_user_id').notNull(),
  stripeCustomerId: text('stripe_customer_id').notNull(),
  stripeSubscriptionId: text('stripe_subscription_id').notNull().unique(),
  stripePriceId: text('stripe_price_id').notNull(),
  status: text('status').notNull(),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull(),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  planId: text('plan_id'),
  billingPeriod: text('billing_period').notNull().default('monthly'),
  planSnapshot: jsonb('plan_snapshot').notNull(),
  ...timestampColumns(),
}, (table) => [
  index('clarity_subscriptions_user_status_idx').on(table.oxyUserId, table.status),
  index('clarity_subscriptions_user_plan_status_idx').on(table.oxyUserId, table.planId, table.status),
  index('clarity_subscriptions_customer_idx').on(table.stripeCustomerId),
  check('clarity_subscriptions_status_check', sql`${table.status} in ('active', 'canceled', 'past_due', 'unpaid', 'trialing', 'incomplete', 'incomplete_expired')`),
  check('clarity_subscriptions_period_check', sql`${table.billingPeriod} in ('monthly', 'annual')`),
]);

export const billingCustomers = pgTable('clarity_billing_customers', {
  oxyUserId: text('oxy_user_id').primaryKey(),
  stripeCustomerId: text('stripe_customer_id').notNull().unique(),
  ...timestampColumns(),
});

/**
 * Backfill/cutover attestation. The runtime may start for migration work, but
 * readiness stays closed until the operator records a reconciled cutover.
 */
export const runtimeState = pgTable('clarity_runtime_state', {
  id: text('id').primaryKey(),
  status: text('status').notNull(),
  sourceSnapshotHash: text('source_snapshot_hash').notNull(),
  aliaAgentIdSha256: text('alia_agent_id_sha256'),
  reconciledAt: timestamp('reconciled_at', { withTimezone: true }).notNull(),
  sourceCounts: jsonb('source_counts').notNull(),
  targetCounts: jsonb('target_counts').notNull(),
  ...timestampColumns(),
}, (table) => [
  check('clarity_runtime_state_status_check', sql`${table.status} in ('reconciled', 'cutover')`),
]);

/** Append-only audit of each source record copied by a future backfill. */
export const backfillReceipts = pgTable('clarity_backfill_receipts', {
  sourceCollection: text('source_collection').notNull(),
  sourceId: text('source_id').notNull(),
  sourceHash: text('source_hash').notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({
    name: 'clarity_backfill_receipts_pk',
    columns: [table.sourceCollection, table.sourceId],
  }),
]);
