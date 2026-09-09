import { sql } from 'drizzle-orm';
import {
  boolean,
  bigint,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  vector,
} from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

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

export const searchSites = pgTable('clarity_search_sites', {
  id: text('id').primaryKey(),
  ownerAccountId: text('owner_account_id').notNull(),
  origin: text('origin').notNull(),
  verifiedDomainId: text('verified_domain_id').notNull(),
  status: text('status').notNull().default('active'),
  crawlEnabled: boolean('crawl_enabled').notNull().default(true),
  recrawlIntervalSeconds: integer('recrawl_interval_seconds').notNull().default(86400),
  maxPagesPerCrawl: integer('max_pages_per_crawl').notNull().default(5000),
  robotsText: text('robots_text'),
  robotsFetchedAt: timestamp('robots_fetched_at', { withTimezone: true }),
  sitemapUrls: text('sitemap_urls').array().notNull().default(sql`'{}'::text[]`),
  feedUrls: text('feed_urls').array().notNull().default(sql`'{}'::text[]`),
  nextCrawlAt: timestamp('next_crawl_at', { withTimezone: true }),
  ...timestampColumns(),
}, (table) => [
  unique('clarity_search_sites_account_origin_unique').on(table.ownerAccountId, table.origin),
  index('clarity_search_sites_next_crawl_idx').on(table.status, table.nextCrawlAt),
  check('clarity_search_sites_status_check', sql`${table.status} in ('active', 'paused', 'removed')`),
  check('clarity_search_sites_interval_check', sql`${table.recrawlIntervalSeconds} >= 900`),
  check('clarity_search_sites_max_pages_check', sql`${table.maxPagesPerCrawl} between 1 and 500000`),
]);

export const searchDocuments = pgTable('clarity_search_documents', {
  id: text('id').primaryKey(),
  siteId: text('site_id').references(() => searchSites.id, { onDelete: 'set null' }),
  requestedUrl: text('requested_url').notNull(),
  finalUrl: text('final_url'),
  canonicalUrl: text('canonical_url').notNull(),
  status: text('status').notNull().default('discovered'),
  documentType: text('document_type').notNull().default('other'),
  contentHash: text('content_hash'),
  httpStatus: integer('http_status'),
  etag: text('etag'),
  lastModified: text('last_modified'),
  contentType: text('content_type'),
  language: text('language'),
  title: text('title'),
  description: text('description'),
  mainContent: text('main_content'),
  structuredData: jsonb('structured_data').notNull().default(sql`'[]'::jsonb`),
  fieldEvidence: jsonb('field_evidence').notNull().default(sql`'{}'::jsonb`),
  publisherName: text('publisher_name'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  modifiedAt: timestamp('modified_at', { withTimezone: true }),
  imageUrl: text('image_url'),
  faviconUrl: text('favicon_url'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  noindex: boolean('noindex').notNull().default(false),
  nofollow: boolean('nofollow').notNull().default(false),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }),
  indexedAt: timestamp('indexed_at', { withTimezone: true }),
  nextFetchAt: timestamp('next_fetch_at', { withTimezone: true }),
  ...timestampColumns(),
}, (table) => [
  unique('clarity_search_documents_canonical_unique').on(table.canonicalUrl),
  index('clarity_search_documents_site_status_idx').on(table.siteId, table.status),
  index('clarity_search_documents_published_idx').on(table.publishedAt),
  index('clarity_search_documents_title_trgm_idx').using('gin', table.title.asc().op('gin_trgm_ops')),
  check('clarity_search_documents_status_check', sql`${table.status} in ('discovered', 'fetching', 'extracted', 'indexed', 'blocked', 'failed', 'removed')`),
  check('clarity_search_documents_type_check', sql`${table.documentType} in ('page', 'article', 'news', 'job', 'product', 'video', 'event', 'recipe', 'profile', 'documentation', 'other')`),
]);

export const searchDocumentAliases = pgTable('clarity_search_document_aliases', {
  url: text('url').primaryKey(),
  documentId: text('document_id').notNull().references(() => searchDocuments.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('clarity_search_document_aliases_document_idx').on(table.documentId)]);

export const searchAuthors = pgTable('clarity_search_authors', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url'),
  sameAs: text('same_as').array().notNull().default(sql`'{}'::text[]`),
});

export const searchDocumentAuthors = pgTable('clarity_search_document_authors', {
  documentId: text('document_id').notNull().references(() => searchDocuments.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull().references(() => searchAuthors.id, { onDelete: 'cascade' }),
  position: integer('position').notNull().default(0),
  evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),
}, (table) => [primaryKey({ name: 'clarity_search_document_authors_pk', columns: [table.documentId, table.authorId] })]);

export const searchOutgoingLinks = pgTable('clarity_search_outgoing_links', {
  id: text('id').primaryKey(),
  sourceDocumentId: text('source_document_id').notNull().references(() => searchDocuments.id, { onDelete: 'cascade' }),
  targetUrl: text('target_url').notNull(),
  anchorText: text('anchor_text'),
  rel: text('rel').array().notNull().default(sql`'{}'::text[]`),
  discoverySource: text('discovery_source').notNull().default('html'),
}, (table) => [index('clarity_search_outgoing_links_source_idx').on(table.sourceDocumentId)]);

export const searchChunks = pgTable('clarity_search_chunks', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull().references(() => searchDocuments.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  startOffset: integer('start_offset').notNull(),
  endOffset: integer('end_offset').notNull(),
  text: text('text').notNull(),
  searchVector: tsvector('search_vector').notNull(),
  embedding: vector('embedding', { dimensions: 1024 }),
  embeddingModel: text('embedding_model'),
  extractorVersion: text('extractor_version').notNull(),
  ...timestampColumns(),
}, (table) => [
  unique('clarity_search_chunks_document_position_unique').on(table.documentId, table.position),
  index('clarity_search_chunks_fts_idx').using('gin', table.searchVector),
  index('clarity_search_chunks_embedding_hnsw_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
]);

export const crawlJobs = pgTable('clarity_crawl_jobs', {
  id: text('id').primaryKey(),
  ownerAccountId: text('owner_account_id').notNull(),
  applicationId: text('application_id').notNull(),
  credentialId: text('credential_id'),
  siteId: text('site_id').references(() => searchSites.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(),
  status: text('status').notNull().default('queued'),
  idempotencyKey: text('idempotency_key').notNull(),
  requestedUrls: text('requested_urls').array().notNull().default(sql`'{}'::text[]`),
  pagesDiscovered: integer('pages_discovered').notNull().default(0),
  pagesCompleted: integer('pages_completed').notNull().default(0),
  errorCode: text('error_code'),
  errorDetail: text('error_detail'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  ...timestampColumns(),
}, (table) => [
  unique('clarity_crawl_jobs_idempotency_unique').on(table.ownerAccountId, table.applicationId, table.idempotencyKey),
  index('clarity_crawl_jobs_account_status_idx').on(table.ownerAccountId, table.status),
  check('clarity_crawl_jobs_status_check', sql`${table.status} in ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')`),
  check('clarity_crawl_jobs_kind_check', sql`${table.kind} in ('urls', 'site', 'recrawl', 'removal')`),
]);

export const crawlPages = pgTable('clarity_crawl_pages', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => crawlJobs.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  discoverySource: text('discovery_source').notNull(),
  status: text('status').notNull().default('queued'),
  attemptCount: integer('attempt_count').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'),
  lastErrorDetail: text('last_error_detail'),
  ...timestampColumns(),
}, (table) => [
  unique('clarity_crawl_pages_job_url_unique').on(table.jobId, table.url),
  index('clarity_crawl_pages_lease_idx').on(table.status, table.availableAt, table.leaseExpiresAt),
]);

export const fetchAttempts = pgTable('clarity_fetch_attempts', {
  id: text('id').primaryKey(),
  crawlPageId: text('crawl_page_id').notNull().references(() => crawlPages.id, { onDelete: 'cascade' }),
  attempt: integer('attempt').notNull(),
  fetchMode: text('fetch_mode').notNull(),
  status: text('status').notNull(),
  httpStatus: integer('http_status'),
  bytesReceived: bigint('bytes_received', { mode: 'number' }),
  durationMs: integer('duration_ms'),
  redirectChain: jsonb('redirect_chain').notNull().default(sql`'[]'::jsonb`),
  errorCode: text('error_code'),
  errorDetail: text('error_detail'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (table) => [unique('clarity_fetch_attempts_page_attempt_unique').on(table.crawlPageId, table.attempt)]);

export const newsStories = pgTable('clarity_news_stories', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  summary: text('summary'),
  language: text('language'),
  firstPublishedAt: timestamp('first_published_at', { withTimezone: true }).notNull(),
  lastPublishedAt: timestamp('last_published_at', { withTimezone: true }).notNull(),
  sourceCount: integer('source_count').notNull().default(1),
  publisherDiversity: integer('publisher_diversity').notNull().default(1),
  rankingScore: doublePrecision('ranking_score').notNull().default(0),
  ...timestampColumns(),
}, (table) => [index('clarity_news_stories_rank_idx').on(table.lastPublishedAt, table.rankingScore)]);

export const newsStoryArticles = pgTable('clarity_news_story_articles', {
  storyId: text('story_id').notNull().references(() => newsStories.id, { onDelete: 'cascade' }),
  documentId: text('document_id').notNull().references(() => searchDocuments.id, { onDelete: 'cascade' }),
  similarity: doublePrecision('similarity').notNull(),
}, (table) => [primaryKey({ name: 'clarity_news_story_articles_pk', columns: [table.storyId, table.documentId] })]);

export const searchUsageEvents = pgTable('clarity_search_usage_events', {
  id: text('id').primaryKey(),
  ownerAccountId: text('owner_account_id').notNull(),
  applicationId: text('application_id').notNull(),
  credentialId: text('credential_id'),
  operation: text('operation').notNull(),
  idempotencyKey: text('idempotency_key'),
  quantity: integer('quantity').notNull().default(1),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('clarity_search_usage_idempotency_unique').on(table.ownerAccountId, table.operation, table.idempotencyKey),
  index('clarity_search_usage_account_time_idx').on(table.ownerAccountId, table.occurredAt),
  check('clarity_search_usage_operation_check', sql`${table.operation} in ('search', 'fetch_started', 'page_indexed', 'browser_render')`),
  check('clarity_search_usage_quantity_check', sql`${table.quantity} > 0`),
]);

export const searchUsageRollups = pgTable('clarity_search_usage_rollups', {
  ownerAccountId: text('owner_account_id').notNull(),
  applicationId: text('application_id').notNull(),
  credentialId: text('credential_id').notNull().default(''),
  operation: text('operation').notNull(),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  quantity: bigint('quantity', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({
  name: 'clarity_search_usage_rollups_pk',
  columns: [table.ownerAccountId, table.applicationId, table.credentialId, table.operation, table.periodStart],
})]);

export const searchQuotaGrants = pgTable('clarity_search_quota_grants', {
  id: text('id').primaryKey(),
  ownerAccountId: text('owner_account_id').notNull(),
  metric: text('metric').notNull(),
  additionalLimit: integer('additional_limit').notNull(),
  reason: text('reason').notNull(),
  grantedBy: text('granted_by').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('clarity_search_quota_grants_account_metric_idx').on(table.ownerAccountId, table.metric, table.expiresAt),
  check('clarity_search_quota_grants_metric_check', sql`${table.metric} in ('search_month', 'fetch_month', 'sites', 'active_crawls', 'pages_per_crawl', 'requests_minute_credential', 'requests_minute_application', 'concurrent_fetches')`),
  check('clarity_search_quota_grants_limit_check', sql`${table.additionalLimit} > 0`),
]);

export const searchRateLimitBuckets = pgTable('clarity_search_rate_limit_buckets', {
  dimension: text('dimension').notNull(),
  dimensionId: text('dimension_id').notNull(),
  bucketStart: timestamp('bucket_start', { withTimezone: true }).notNull(),
  quantity: integer('quantity').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ name: 'clarity_search_rate_limit_buckets_pk', columns: [table.dimension, table.dimensionId, table.bucketStart] }),
  index('clarity_search_rate_limit_buckets_expiry_idx').on(table.expiresAt),
  check('clarity_search_rate_limit_buckets_dimension_check', sql`${table.dimension} in ('credential', 'application')`),
  check('clarity_search_rate_limit_buckets_quantity_check', sql`${table.quantity} > 0`),
]);

/**
 * Clarity Jobs — the normalized employment projection.
 *
 * A row is a SEARCH REPRESENTATION of one public listing, derived from the
 * `search_documents` row it points at. The canonical external page stays
 * authoritative for externally authored listings; Clarity never becomes a
 * second source of truth, an applicant tracker or a candidate store. No column
 * here may express a commercial relationship — ranking must remain unable to
 * read one. See `docs/jobs.mdx`.
 */
export const jobClusters = pgTable('clarity_job_clusters', {
  id: text('id').primaryKey(),
  /** The member Clarity shows; every other member stays queryable. */
  canonicalJobPostingId: text('canonical_job_posting_id'),
  memberCount: integer('member_count').notNull().default(1),
  ...timestampColumns(),
}, (table) => [
  check('clarity_job_clusters_member_count_check', sql`${table.memberCount} > 0`),
]);

export const jobPostings = pgTable('clarity_job_postings', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull().references(() => searchDocuments.id, { onDelete: 'cascade' }),
  /** Requisition id, listing URL or ordinal — stable within one document. */
  sourceKey: text('source_key').notNull(),
  clusterId: text('cluster_id').references(() => jobClusters.id, { onDelete: 'set null' }),

  canonicalUrl: text('canonical_url').notNull(),
  applyUrl: text('apply_url'),
  title: text('title').notNull(),
  normalizedTitle: text('normalized_title').notNull(),
  description: text('description'),
  descriptionFingerprint: text('description_fingerprint'),

  employerName: text('employer_name').notNull(),
  employerUrl: text('employer_url'),
  employerDomain: text('employer_domain'),
  employerLogoUrl: text('employer_logo_url'),
  employerKey: text('employer_key'),

  locations: jsonb('locations').notNull().default(sql`'[]'::jsonb`),
  locationCountries: text('location_countries').array().notNull().default(sql`'{}'::text[]`),
  locationRegions: text('location_regions').array().notNull().default(sql`'{}'::text[]`),
  locationLocalities: text('location_localities').array().notNull().default(sql`'{}'::text[]`),
  applicantLocationRequirements: text('applicant_location_requirements').array().notNull().default(sql`'{}'::text[]`),
  workplaceType: text('workplace_type'),
  employmentTypes: text('employment_types').array().notNull().default(sql`'{}'::text[]`),

  salaryMin: doublePrecision('salary_min'),
  salaryMax: doublePrecision('salary_max'),
  salaryCurrency: text('salary_currency'),
  salaryInterval: text('salary_interval'),
  /** Source amount at the documented working-time factors, for filtering only. */
  salaryAnnualMin: doublePrecision('salary_annual_min'),
  salaryAnnualMax: doublePrecision('salary_annual_max'),

  skills: text('skills').array().notNull().default(sql`'{}'::text[]`),
  qualifications: text('qualifications'),
  responsibilities: text('responsibilities'),
  educationRequirements: text('education_requirements'),
  experienceRequirements: text('experience_requirements'),
  industry: text('industry'),
  occupationalCategory: text('occupational_category'),
  identifier: text('identifier'),
  directApply: boolean('direct_apply'),

  publishedAt: timestamp('published_at', { withTimezone: true }),
  validThrough: timestamp('valid_through', { withTimezone: true }),
  status: text('status').notNull().default('active'),
  closureReason: text('closure_reason'),
  closedAt: timestamp('closed_at', { withTimezone: true }),

  sourceType: text('source_type').notNull().default('web'),
  sourceDomain: text('source_domain').notNull(),
  /** Oxy application that handed Clarity a first-party listing, if any. */
  submittedByApplicationId: text('submitted_by_application_id'),
  fieldEvidence: jsonb('field_evidence').notNull().default(sql`'{}'::jsonb`),

  searchVector: tsvector('search_vector').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  ...timestampColumns(),
}, (table) => [
  unique('clarity_job_postings_document_source_unique').on(table.documentId, table.sourceKey),
  index('clarity_job_postings_status_published_idx').on(table.status, table.publishedAt),
  index('clarity_job_postings_status_last_seen_idx').on(table.status, table.lastSeenAt),
  index('clarity_job_postings_valid_through_idx').on(table.validThrough),
  index('clarity_job_postings_cluster_idx').on(table.clusterId),
  index('clarity_job_postings_employer_idx').on(table.employerKey),
  index('clarity_job_postings_source_domain_idx').on(table.sourceDomain),
  index('clarity_job_postings_canonical_url_idx').on(table.canonicalUrl),
  index('clarity_job_postings_search_idx').using('gin', table.searchVector),
  index('clarity_job_postings_countries_idx').using('gin', table.locationCountries),
  index('clarity_job_postings_employment_types_idx').using('gin', table.employmentTypes),
  index('clarity_job_postings_skills_idx').using('gin', table.skills),
  index('clarity_job_postings_title_trgm_idx').using('gin', table.title.asc().op('gin_trgm_ops')),
  check('clarity_job_postings_status_check', sql`${table.status} in ('active', 'expired', 'closed', 'removed', 'stale')`),
  check('clarity_job_postings_workplace_check', sql`${table.workplaceType} is null or ${table.workplaceType} in ('remote', 'hybrid', 'onsite')`),
  check('clarity_job_postings_source_type_check', sql`${table.sourceType} in ('web', 'verified_site', 'first_party', 'feed')`),
  check('clarity_job_postings_salary_interval_check', sql`${table.salaryInterval} is null or ${table.salaryInterval} in ('hour', 'day', 'week', 'month', 'year')`),
  check('clarity_job_postings_salary_currency_check', sql`${table.salaryCurrency} is null or ${table.salaryCurrency} ~ '^[A-Z]{3}$'`),
]);

/**
 * Grouping evidence. Deleting a row unlinks that evidence without destroying
 * the listing, which is what makes a dedupe decision reversible.
 */
export const jobPostingSignatures = pgTable('clarity_job_posting_signatures', {
  jobPostingId: text('job_posting_id').notNull().references(() => jobPostings.id, { onDelete: 'cascade' }),
  signature: text('signature').notNull(),
  kind: text('kind').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: 'clarity_job_posting_signatures_pk', columns: [table.jobPostingId, table.signature] }),
  index('clarity_job_posting_signatures_signature_idx').on(table.signature),
  check('clarity_job_posting_signatures_kind_check', sql`${table.kind} in ('identifier', 'listing_url', 'content')`),
]);

/**
 * Reader reports about a listing (scam, already filled, misleading, …).
 *
 * Deliberately carries NO reporter identity: no user id, no address, no device.
 * A report is an operator signal, never an automatic demotion — reports are not
 * a permitted ranking input, and the Jobs ranker cannot read this table.
 */
export const jobReports = pgTable('clarity_job_reports', {
  id: text('id').primaryKey(),
  jobPostingId: text('job_posting_id').notNull().references(() => jobPostings.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  detail: text('detail'),
  status: text('status').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('clarity_job_reports_status_created_idx').on(table.status, table.createdAt),
  index('clarity_job_reports_posting_idx').on(table.jobPostingId),
  check('clarity_job_reports_reason_check', sql`${table.reason} in ('scam', 'already_filled', 'duplicate', 'misleading', 'discriminatory', 'other')`),
  check('clarity_job_reports_status_check', sql`${table.status} in ('open', 'reviewed', 'actioned', 'dismissed')`),
]);

/**
 * Keyless public listing endpoints Clarity polls for jobs.
 *
 * Sources are DATA, not a hardcoded list: adding a company's board or a feed is
 * a row, not a deploy, and nothing here assumes every job comes from an ATS.
 * No column holds a credential, because every supported kind is a public
 * endpoint that needs none — Clarity registers with nobody to read a public
 * board, and the listing's own URL stays its canonical source.
 */
export const jobFeeds = pgTable('clarity_job_feeds', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  /** Board token, company slug or feed URL, depending on `kind`. */
  identifier: text('identifier').notNull(),
  label: text('label'),
  enabled: boolean('enabled').notNull().default(true),
  pollIntervalSeconds: integer('poll_interval_seconds').notNull().default(21600),
  nextPollAt: timestamp('next_poll_at', { withTimezone: true }).notNull().defaultNow(),
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
  lastStatus: text('last_status'),
  lastError: text('last_error'),
  listingsSeen: integer('listings_seen').notNull().default(0),
  ...timestampColumns(),
}, (table) => [
  unique('clarity_job_feeds_kind_identifier_unique').on(table.kind, table.identifier),
  index('clarity_job_feeds_due_idx').on(table.enabled, table.nextPollAt),
  check('clarity_job_feeds_kind_check', sql`${table.kind} in ('greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'remoteok', 'remotive', 'arbeitnow', 'rss')`),
  check('clarity_job_feeds_status_check', sql`${table.lastStatus} is null or ${table.lastStatus} in ('ok', 'error')`),
  check('clarity_job_feeds_interval_check', sql`${table.pollIntervalSeconds} >= 900`),
  check('clarity_job_feeds_listings_check', sql`${table.listingsSeen} >= 0`),
]);
