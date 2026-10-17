import { sql } from 'drizzle-orm';
import {
  boolean,
  bigint,
  check,
  customType,
  date,
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
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

const timestampColumns = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const suggestions = pgTable(
  'clarity_suggestions',
  {
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
  },
  (table) => [
    index('clarity_suggestions_scope_language_type_idx').on(
      table.scope,
      table.language,
      table.type,
    ),
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
  ],
);

export const plans = pgTable(
  'clarity_plans',
  {
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
    isActive: boolean('is_active').notNull().default(true),
    isFree: boolean('is_free').notNull().default(false),
    stripeProductId: text('stripe_product_id'),
    stripeMonthlyPriceId: text('stripe_monthly_price_id'),
    stripeAnnualPriceId: text('stripe_annual_price_id'),
    description: text('description'),
    notes: text('notes'),
    ...timestampColumns(),
  },
  (table) => [
    index('clarity_plans_product_sort_idx').on(table.product, table.sortOrder),
    index('clarity_plans_product_active_idx').on(table.product, table.isActive),
    check('clarity_plans_product_check', sql`${table.product} in ('clarity', 'codea')`),
    check(
      'clarity_plans_prices_check',
      sql`${table.monthlyPrice} >= 0 and ${table.annualPrice} >= 0`,
    ),
  ],
);

export const features = pgTable(
  'clarity_features',
  {
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
  },
  (table) => [
    index('clarity_features_category_sort_idx').on(table.category, table.sortOrder),
    check('clarity_features_type_check', sql`${table.featureType} in ('boolean', 'limit')`),
  ],
);

export const planFeatures = pgTable(
  'clarity_plan_features',
  {
    /** Exact legacy source `_id`; product joins continue to use exact plan/feature IDs. */
    id: text('id').notNull().unique(),
    planId: text('plan_id').notNull(),
    featureId: text('feature_id').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    limitValue: integer('limit_value'),
    displayLabel: text('display_label'),
    displayDescription: text('display_description'),
    ...timestampColumns(),
  },
  (table) => [
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
  ],
);

/**
 * Legacy product catalogue data retained for lossless cutover reconciliation.
 * Live inference-credit offers are read from Alia; Clarity never mutates this
 * table after import and can retire it only after an operator-approved archive.
 */
export const creditPackages = pgTable(
  'clarity_credit_packages',
  {
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
  },
  (table) => [
    index('clarity_credit_packages_active_sort_idx').on(table.isActive, table.sortOrder),
    check('clarity_credit_packages_credits_check', sql`${table.credits} > 0`),
    check('clarity_credit_packages_price_check', sql`${table.price} >= 0`),
  ],
);

export const feedback = pgTable(
  'clarity_feedback',
  {
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
  },
  (table) => [
    index('clarity_feedback_user_created_idx').on(table.oxyUserId, table.createdAt),
    index('clarity_feedback_status_idx').on(table.status),
    index('clarity_feedback_type_idx').on(table.type),
    check(
      'clarity_feedback_type_check',
      sql`${table.type} in ('bug', 'feature', 'improvement', 'other')`,
    ),
    check(
      'clarity_feedback_status_check',
      sql`${table.status} in ('pending', 'reviewed', 'resolved')`,
    ),
    check(
      'clarity_feedback_rating_check',
      sql`${table.rating} is null or ${table.rating} between 1 and 5`,
    ),
  ],
);

export const notifications = pgTable(
  'clarity_notifications',
  {
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
  },
  (table) => [
    index('clarity_notifications_user_status_created_idx').on(
      table.oxyUserId,
      table.status,
      table.createdAt,
    ),
    index('clarity_notifications_expires_idx').on(table.expiresAt),
    check(
      'clarity_notifications_type_check',
      sql`${table.type} in ('trigger_result', 'proactive_insight', 'daily_briefing', 'price_alert', 'integration_event', 'reminder', 'agent_task_complete', 'chat_response_ready', 'oxy_service')`,
    ),
    check(
      'clarity_notifications_status_check',
      sql`${table.status} in ('pending', 'sent', 'read', 'dismissed')`,
    ),
    check(
      'clarity_notifications_priority_check',
      sql`${table.priority} in ('low', 'normal', 'high', 'urgent')`,
    ),
  ],
);

export const pushTokens = pgTable(
  'clarity_push_tokens',
  {
    id: text('id').primaryKey(),
    oxyUserId: text('oxy_user_id').notNull(),
    token: text('token').notNull(),
    deviceId: text('device_id'),
    platform: text('platform'),
    active: boolean('active').notNull().default(true),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    unique('clarity_push_tokens_user_token_unique').on(table.oxyUserId, table.token),
    index('clarity_push_tokens_token_idx').on(table.token),
    check(
      'clarity_push_tokens_platform_check',
      sql`${table.platform} is null or ${table.platform} in ('ios', 'android', 'web')`,
    ),
  ],
);

export const webPushSubscriptions = pgTable(
  'clarity_web_push_subscriptions',
  {
    id: text('id').primaryKey(),
    oxyUserId: text('oxy_user_id').notNull(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    active: boolean('active').notNull().default(true),
    ...timestampColumns(),
  },
  (table) => [unique('clarity_web_push_user_endpoint_unique').on(table.oxyUserId, table.endpoint)],
);

/** Clarity product membership only. Inference credits and usage are owned by Alia. */
export const subscriptions = pgTable(
  'clarity_subscriptions',
  {
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
  },
  (table) => [
    index('clarity_subscriptions_user_status_idx').on(table.oxyUserId, table.status),
    index('clarity_subscriptions_user_plan_status_idx').on(
      table.oxyUserId,
      table.planId,
      table.status,
    ),
    index('clarity_subscriptions_customer_idx').on(table.stripeCustomerId),
    check(
      'clarity_subscriptions_status_check',
      sql`${table.status} in ('active', 'canceled', 'past_due', 'unpaid', 'trialing', 'incomplete', 'incomplete_expired')`,
    ),
    check(
      'clarity_subscriptions_period_check',
      sql`${table.billingPeriod} in ('monthly', 'annual')`,
    ),
  ],
);

export const billingCustomers = pgTable('clarity_billing_customers', {
  oxyUserId: text('oxy_user_id').primaryKey(),
  stripeCustomerId: text('stripe_customer_id').notNull().unique(),
  ...timestampColumns(),
});

/**
 * Backfill/cutover attestation. The runtime may start for migration work, but
 * readiness stays closed until the operator records a reconciled cutover.
 *
 * `fresh_install` is the other way readiness ever opens: a deployment that
 * never had prior data to migrate at all, attested by `attest-fresh-install.ts`
 * rather than `attest-cutover.ts`. It carries no snapshot — there is nothing to
 * hash — so the snapshot/reconciliation columns stay NULL for that row only;
 * the check below enforces the two shapes never mix.
 */
export const runtimeState = pgTable(
  'clarity_runtime_state',
  {
    id: text('id').primaryKey(),
    status: text('status').notNull(),
    sourceSnapshotHash: text('source_snapshot_hash'),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    sourceCounts: jsonb('source_counts'),
    targetCounts: jsonb('target_counts'),
    ...timestampColumns(),
  },
  (table) => [
    check(
      'clarity_runtime_state_status_check',
      sql`${table.status} in ('reconciled', 'cutover', 'fresh_install')`,
    ),
    check(
      'clarity_runtime_state_fresh_install_has_no_snapshot',
      sql`(${table.status} = 'fresh_install' and ${table.sourceSnapshotHash} is null and ${table.reconciledAt} is null and ${table.sourceCounts} is null and ${table.targetCounts} is null)
        or (${table.status} in ('reconciled', 'cutover') and ${table.sourceSnapshotHash} is not null and ${table.reconciledAt} is not null and ${table.sourceCounts} is not null and ${table.targetCounts} is not null)`,
    ),
  ],
);

/** Append-only audit of each source record copied by a future backfill. */
export const backfillReceipts = pgTable(
  'clarity_backfill_receipts',
  {
    sourceCollection: text('source_collection').notNull(),
    sourceId: text('source_id').notNull(),
    sourceHash: text('source_hash').notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'clarity_backfill_receipts_pk',
      columns: [table.sourceCollection, table.sourceId],
    }),
  ],
);

export const searchSites = pgTable(
  'clarity_search_sites',
  {
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
  },
  (table) => [
    unique('clarity_search_sites_account_origin_unique').on(table.ownerAccountId, table.origin),
    index('clarity_search_sites_next_crawl_idx').on(table.status, table.nextCrawlAt),
    check(
      'clarity_search_sites_status_check',
      sql`${table.status} in ('active', 'paused', 'removed')`,
    ),
    check('clarity_search_sites_interval_check', sql`${table.recrawlIntervalSeconds} >= 900`),
    check(
      'clarity_search_sites_max_pages_check',
      sql`${table.maxPagesPerCrawl} between 1 and 500000`,
    ),
  ],
);

export const searchDocuments = pgTable(
  'clarity_search_documents',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id').references(() => searchSites.id, { onDelete: 'set null' }),
    requestedUrl: text('requested_url').notNull(),
    finalUrl: text('final_url'),
    canonicalUrl: text('canonical_url').notNull(),
    status: text('status').notNull().default('discovered'),
    documentType: text('document_type').notNull().default('other'),
    /**
     * Fingerprint of the stored content, as its writer derived it: the crawl
     * worker hashes the page text, job ingestion its whole payload. Every
     * write of the content columns sets it (or clears it), because ingestion
     * rewrites nothing but the observation while it still matches.
     */
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
  },
  (table) => [
    unique('clarity_search_documents_canonical_unique').on(table.canonicalUrl),
    // A page is found by any of the URLs it answered to (`fetchedDocuments`,
    // the worker's already-fetched and gone checks), so each one is indexed;
    // only a redirected fetch has a final URL.
    index('clarity_search_documents_requested_url_idx').on(table.requestedUrl),
    index('clarity_search_documents_final_url_idx')
      .on(table.finalUrl)
      .where(sql`${table.finalUrl} is not null`),
    index('clarity_search_documents_site_status_idx').on(table.siteId, table.status),
    index('clarity_search_documents_published_idx').on(table.publishedAt),
    // The two sweeps that ask "what is due?" (`enqueueJobRecrawls`, the news
    // feed's candidates) read only these rows. Unindexed, each run read the
    // whole table, and with nothing due a LIMIT never stops one early.
    index('clarity_search_documents_job_recrawl_due_idx')
      .on(table.nextFetchAt)
      .where(
        sql`${table.documentType} = 'job' and ${table.status} = 'indexed' and ${table.nextFetchAt} is not null`,
      ),
    index('clarity_search_documents_news_recent_idx')
      .on(sql`(coalesce(${table.publishedAt}, ${table.indexedAt})) desc nulls last`)
      .where(
        sql`${table.documentType} = 'news' and ${table.status} = 'indexed' and ${table.noindex} = false`,
      ),
    index('clarity_search_documents_title_trgm_idx').using(
      'gin',
      table.title.asc().op('gin_trgm_ops'),
    ),
    check(
      'clarity_search_documents_status_check',
      sql`${table.status} in ('discovered', 'fetching', 'extracted', 'indexed', 'blocked', 'failed', 'removed')`,
    ),
    check(
      'clarity_search_documents_type_check',
      sql`${table.documentType} in ('page', 'article', 'news', 'job', 'product', 'video', 'event', 'recipe', 'profile', 'documentation', 'other')`,
    ),
  ],
);

/**
 * One row per host Clarity has seen a page from, holding that site's favicon.
 *
 * Favicons belong to a site, not a page, so they are fetched once per host and
 * served from Clarity (`GET /favicons/:host`) rather than hotlinked from each
 * site or looked up through a third party. `icon_hint_url` is what a crawled
 * page declared (`<link rel="icon">`); the fetcher tries it before the site's
 * `/favicon.ico` (search/site-icons.ts).
 */
export const searchHosts = pgTable(
  'clarity_search_hosts',
  {
    host: text('host').primaryKey(),
    iconStatus: text('icon_status').notNull().default('pending'),
    iconHintUrl: text('icon_hint_url'),
    iconSourceUrl: text('icon_source_url'),
    iconContentType: text('icon_content_type'),
    /**
     * The icon's bytes, kept in Postgres only during the soak: for an icon
     * stored before the move to Oxy Files that `images:migrate-to-oxy` has not
     * copied yet, and for an SVG an Oxy without stage 4c refused
     * (`files/oxy-files.ts`). Every other icon, SVG included, is
     * `icon_oxy_file_id`. Dropped only by the retirement step's `post`
     * migration, once `images:storage-status` is ready.
     */
    iconBytes: bytea('icon_bytes'),
    /** The Clarity-owned Oxy file holding the icon (ADR 0043), when Oxy holds it. */
    iconOxyFileId: text('icon_oxy_file_id'),
    iconFetchedAt: timestamp('icon_fetched_at', { withTimezone: true }),
    iconNextFetchAt: timestamp('icon_next_fetch_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestampColumns(),
  },
  (table) => [
    index('clarity_search_hosts_icon_due_idx').on(table.iconNextFetchAt),
    // `blocked`: Oxy took the icon's file down after a content claim (a
    // `file.blocked` event); it is not served until `file.unblocked`.
    check(
      'clarity_search_hosts_icon_status_check',
      sql`${table.iconStatus} in ('pending', 'ready', 'missing', 'blocked')`,
    ),
    check(
      'clarity_search_hosts_icon_ready_check',
      sql`${table.iconStatus} <> 'ready' or (${table.iconContentType} is not null and (${table.iconBytes} is not null or ${table.iconOxyFileId} is not null))`,
    ),
    index('clarity_search_hosts_icon_oxy_file_idx')
      .on(table.iconOxyFileId)
      .where(sql`${table.iconOxyFileId} is not null`),
  ],
);

/**
 * The remote images Clarity's API shows — a document's preview image and a
 * job's employer logo — keyed by the SHA-256 of the source URL, so every
 * document or job pointing at one image shares one row.
 *
 * Since ADR 0043 the image itself is a CLARITY-OWNED Oxy file
 * (`oxy_file_id`): Oxy imported it by URL, keeps it, renders its sizes and
 * serves it from its CDN, and garbage-collects it once nothing references it
 * (search/image-cache.ts, files/references.ts). A consumer still loads
 * `GET /images/...` from Clarity, which redirects to the file.
 *
 * `bytes` is the copy Clarity used to keep itself (a WebP rendition). It is
 * READ ONLY now: no write path fills it, `images:migrate-to-oxy` copies it into
 * Oxy and clears it, and the column goes in the storage-retirement step
 * (docs/oxy-files.md) once no request has read it for the soak window.
 *
 * `missing` remembers a failed fetch briefly so a broken image is not
 * re-fetched on every request; `blocked` is an image Oxy took down after a
 * content claim, never served and never re-imported until `file.unblocked`.
 */
export const imageCache = pgTable(
  'clarity_image_cache',
  {
    key: text('key').primaryKey(),
    sourceUrl: text('source_url').notNull(),
    status: text('status').notNull(),
    /** The Clarity-owned Oxy file holding this image. */
    oxyFileId: text('oxy_file_id'),
    /** Legacy copy only (see above). */
    contentType: text('content_type'),
    /** Legacy copy only (see above). */
    bytes: bytea('bytes'),
    byteSize: integer('byte_size').notNull().default(0),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Which `image-render.ts` pipeline produced the legacy `bytes`. 0 is a row
     * from before renditions existed, which may hold a site's original; the
     * migration renders it before copying it into Oxy.
     */
    rendition: integer('rendition').notNull().default(0),
  },
  (table) => [
    index('clarity_image_cache_last_accessed_idx').on(table.lastAccessedAt),
    index('clarity_image_cache_rendition_idx')
      .on(table.rendition)
      .where(sql`${table.status} = 'ready'`),
    index('clarity_image_cache_oxy_file_idx')
      .on(table.oxyFileId)
      .where(sql`${table.oxyFileId} is not null`),
    // The migration and the retirement check read only rows still holding bytes.
    index('clarity_image_cache_legacy_idx').on(table.key).where(sql`${table.bytes} is not null`),
    check(
      'clarity_image_cache_status_check',
      sql`${table.status} in ('ready', 'missing', 'blocked')`,
    ),
    check(
      'clarity_image_cache_ready_check',
      sql`${table.status} <> 'ready' or ${table.oxyFileId} is not null or (${table.bytes} is not null and ${table.contentType} is not null)`,
    ),
    check(
      'clarity_image_cache_blocked_check',
      sql`${table.status} <> 'blocked' or ${table.oxyFileId} is not null`,
    ),
  ],
);

/**
 * Which Clarity entity SHOWS which Clarity-owned Oxy file — the inventory of
 * Clarity's ADR 0043 references, one row per entity (an entity shows one
 * image of its kind):
 *
 * - `search_document`: a document's preview image (`/images/documents/:id`);
 * - `job_posting`: a job's employer logo (`/images/jobs/:id`);
 * - `search_host`: a site's favicon (`/favicons/:host`).
 *
 * A row is written the first time the entity's image is served and its
 * `last_used_at` is moved (at most daily) whenever it is served again. It goes
 * — and with it Clarity's reference in Oxy — when the image STOPS BEING USED,
 * which is exactly one of:
 *
 * 1. the entity no longer shows that image: a document's `image_url` or a
 *    job's `employer_logo_url` changes or is cleared, or a host's icon is
 *    replaced (triggers, and `site-icons.ts`);
 * 2. the entity is deleted (triggers, including the cascade from a pruned
 *    document to its job postings);
 * 3. nobody has been served it from that entity for `IMAGE_IDLE_TTL_MS` (30
 *    days): the "last used" rule Clarity's own cache sweep used to apply, now
 *    applied to the reference (files/references.ts `releaseIdleReferences`).
 *
 * After that Oxy owns the rest (ADR 0043 D5): an application file nothing
 * references is trashed after 24 hours and deleted 30 days later, and a new
 * reference in between restores it. Every insert, delete and file change here
 * is mirrored into `clarity_oxy_file_reference_outbox` by a trigger in the same
 * transaction, so no path can change the inventory without telling Oxy.
 */
export const imageReferences = pgTable(
  'clarity_image_references',
  {
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    oxyFileId: text('oxy_file_id').notNull(),
    /**
     * The `clarity_image_cache` row the file came from (documents and jobs);
     * NULL for a favicon. CASCADE: a forgotten image releases its uses.
     */
    imageKey: text('image_key').references(() => imageCache.key, { onDelete: 'cascade' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.entityType, table.entityId] }),
    index('clarity_image_references_file_idx').on(table.oxyFileId),
    index('clarity_image_references_image_key_idx')
      .on(table.imageKey)
      .where(sql`${table.imageKey} is not null`),
    index('clarity_image_references_last_used_idx').on(table.lastUsedAt),
    check(
      'clarity_image_references_entity_type_check',
      sql`${table.entityType} in ('search_document', 'job_posting', 'search_host')`,
    ),
    check(
      'clarity_image_references_image_key_check',
      sql`(${table.entityType} = 'search_host') = (${table.imageKey} is null)`,
    ),
  ],
);

/**
 * Reference changes owed to Oxy, written by triggers on
 * `clarity_image_references` in the transaction that made them and drained in
 * id order by the worker (files/references.ts). A row is deleted once Oxy has
 * answered it; a failure backs the head of the queue off and keeps the order.
 */
export const oxyFileReferenceOutbox = pgTable(
  'clarity_oxy_file_reference_outbox',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    op: text('op').notNull(),
    oxyFileId: text('oxy_file_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('clarity_oxy_file_reference_outbox_op_check', sql`${table.op} in ('add', 'remove')`),
  ],
);

/**
 * File events Oxy delivered (ADR 0043 D9), by event id: delivery is at least
 * once, so an event is acted on only by the request that inserts its row.
 * Swept after 30 days, when Oxy's own delivery row has expired too.
 */
export const oxyFileEvents = pgTable('clarity_oxy_file_events', {
  eventId: text('event_id').primaryKey(),
  type: text('type').notNull(),
  oxyFileId: text('oxy_file_id').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Leases and schedules of the worker's Oxy Files jobs (the outbox drain, one
 * reconciliation per entity type), so only one worker replica runs each.
 */
export const oxyFileJobs = pgTable('clarity_oxy_file_jobs', {
  name: text('name').primaryKey(),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull().defaultNow(),
  leasedUntil: timestamp('leased_until', { withTimezone: true }),
  lastResult: jsonb('last_result'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Requests answered from Clarity's OWN image bytes, per day and surface — the
 * measure the storage-retirement step is gated on (docs/oxy-files.md).
 * Every surface is a legacy read of a copy not yet in Oxy; `favicons_svg`
 * counts the SVG icons apart (an Oxy without stage 4c refuses them, so they are
 * the last to move), and blocks the retirement like the others.
 */
export const legacyImageReads = pgTable(
  'clarity_legacy_image_reads',
  {
    day: date('day', { mode: 'string' }).notNull(),
    surface: text('surface').notNull(),
    reads: bigint('reads', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.day, table.surface] }),
    check(
      'clarity_legacy_image_reads_surface_check',
      sql`${table.surface} in ('images', 'favicons', 'favicons_svg')`,
    ),
  ],
);

export const searchDocumentAliases = pgTable(
  'clarity_search_document_aliases',
  {
    url: text('url').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => searchDocuments.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('clarity_search_document_aliases_document_idx').on(table.documentId)],
);

export const searchAuthors = pgTable('clarity_search_authors', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url'),
  sameAs: text('same_as').array().notNull().default(sql`'{}'::text[]`),
});

export const searchDocumentAuthors = pgTable(
  'clarity_search_document_authors',
  {
    documentId: text('document_id')
      .notNull()
      .references(() => searchDocuments.id, { onDelete: 'cascade' }),
    authorId: text('author_id')
      .notNull()
      .references(() => searchAuthors.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    primaryKey({
      name: 'clarity_search_document_authors_pk',
      columns: [table.documentId, table.authorId],
    }),
  ],
);

export const searchOutgoingLinks = pgTable(
  'clarity_search_outgoing_links',
  {
    id: text('id').primaryKey(),
    sourceDocumentId: text('source_document_id')
      .notNull()
      .references(() => searchDocuments.id, { onDelete: 'cascade' }),
    targetUrl: text('target_url').notNull(),
    anchorText: text('anchor_text'),
    rel: text('rel').array().notNull().default(sql`'{}'::text[]`),
    discoverySource: text('discovery_source').notNull().default('html'),
  },
  (table) => [index('clarity_search_outgoing_links_source_idx').on(table.sourceDocumentId)],
);

export const searchChunks = pgTable(
  'clarity_search_chunks',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => searchDocuments.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    startOffset: integer('start_offset').notNull(),
    endOffset: integer('end_offset').notNull(),
    text: text('text').notNull(),
    searchVector: tsvector('search_vector').notNull(),
    embedding: vector('embedding', { dimensions: 1024 }),
    embeddingModel: text('embedding_model'),
    extractorVersion: text('extractor_version').notNull(),
    ...timestampColumns(),
  },
  (table) => [
    unique('clarity_search_chunks_document_position_unique').on(table.documentId, table.position),
    index('clarity_search_chunks_fts_idx').using('gin', table.searchVector),
    index('clarity_search_chunks_embedding_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
  ],
);

export const crawlJobs = pgTable(
  'clarity_crawl_jobs',
  {
    id: text('id').primaryKey(),
    ownerAccountId: text('owner_account_id').notNull(),
    applicationId: text('application_id').notNull(),
    credentialId: text('credential_id'),
    siteId: text('site_id').references(() => searchSites.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('queued'),
    idempotencyKey: text('idempotency_key').notNull(),
    requestedUrls: text('requested_urls').array().notNull().default(sql`'{}'::text[]`),
    /**
     * Whether the application that queued the crawl is one of Oxy's own
     * (`internal`) or not: the worker charges fetches against the quotas of that
     * caller, and only an external one has any (search/quotas.ts).
     */
    callerTier: text('caller_tier').notNull().default('external'),
    pagesDiscovered: integer('pages_discovered').notNull().default(0),
    pagesCompleted: integer('pages_completed').notNull().default(0),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    unique('clarity_crawl_jobs_idempotency_unique').on(
      table.ownerAccountId,
      table.applicationId,
      table.idempotencyKey,
    ),
    index('clarity_crawl_jobs_account_status_idx').on(table.ownerAccountId, table.status),
    check(
      'clarity_crawl_jobs_status_check',
      sql`${table.status} in ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')`,
    ),
    check(
      'clarity_crawl_jobs_kind_check',
      sql`${table.kind} in ('urls', 'site', 'recrawl', 'removal')`,
    ),
    check(
      'clarity_crawl_jobs_caller_tier_check',
      sql`${table.callerTier} in ('internal', 'external')`,
    ),
  ],
);

export const crawlPages = pgTable(
  'clarity_crawl_pages',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => crawlJobs.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    discoverySource: text('discovery_source').notNull(),
    status: text('status').notNull().default('queued'),
    attemptCount: integer('attempt_count').notNull().default(0),
    /** Live resolve reads outrank untouched historical bulk work. */
    priority: integer('priority').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    lastErrorDetail: text('last_error_detail'),
    ...timestampColumns(),
  },
  (table) => [
    unique('clarity_crawl_pages_job_url_unique').on(table.jobId, table.url),
    index('clarity_crawl_pages_lease_idx').on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
    index('clarity_crawl_pages_url_status_idx').on(table.url, table.status),
    index('clarity_crawl_pages_priority_idx').on(
      table.status,
      table.priority.desc(),
      table.availableAt,
      table.leaseExpiresAt,
    ),
    // The worker's claim (`leaseNextPage`): queued/retry pages in EXACTLY its
    // ORDER BY, partial on the two claimable statuses. Without it Postgres can
    // not walk an index in that order (the status OR splits it), so every claim
    // seq-scanned all pages and sorted ~520k rows to keep one — measured on
    // 2026-10-10 as the largest single CPU consumer of the shared oxy-postgres
    // (569 ms per claim on a same-size copy; 0.11 ms with this index).
    index('clarity_crawl_pages_claim_idx')
      .on(table.priority.desc(), table.availableAt, table.createdAt, table.id)
      .where(sql`${table.status} in ('queued', 'retry')`),
  ],
);

export const fetchAttempts = pgTable(
  'clarity_fetch_attempts',
  {
    id: text('id').primaryKey(),
    crawlPageId: text('crawl_page_id')
      .notNull()
      .references(() => crawlPages.id, { onDelete: 'cascade' }),
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
  },
  (table) => [
    unique('clarity_fetch_attempts_page_attempt_unique').on(table.crawlPageId, table.attempt),
  ],
);

export const newsStories = pgTable(
  'clarity_news_stories',
  {
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
  },
  (table) => [index('clarity_news_stories_rank_idx').on(table.lastPublishedAt, table.rankingScore)],
);

export const newsStoryArticles = pgTable(
  'clarity_news_story_articles',
  {
    storyId: text('story_id')
      .notNull()
      .references(() => newsStories.id, { onDelete: 'cascade' }),
    documentId: text('document_id')
      .notNull()
      .references(() => searchDocuments.id, { onDelete: 'cascade' }),
    similarity: doublePrecision('similarity').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'clarity_news_story_articles_pk',
      columns: [table.storyId, table.documentId],
    }),
  ],
);

export const searchUsageEvents = pgTable(
  'clarity_search_usage_events',
  {
    id: text('id').primaryKey(),
    ownerAccountId: text('owner_account_id').notNull(),
    applicationId: text('application_id').notNull(),
    credentialId: text('credential_id'),
    operation: text('operation').notNull(),
    idempotencyKey: text('idempotency_key'),
    quantity: integer('quantity').notNull().default(1),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('clarity_search_usage_idempotency_unique').on(
      table.ownerAccountId,
      table.operation,
      table.idempotencyKey,
    ),
    index('clarity_search_usage_account_time_idx').on(table.ownerAccountId, table.occurredAt),
    check(
      'clarity_search_usage_operation_check',
      sql`${table.operation} in ('search', 'fetch_started', 'page_indexed', 'browser_render')`,
    ),
    check('clarity_search_usage_quantity_check', sql`${table.quantity} > 0`),
  ],
);

export const searchUsageRollups = pgTable(
  'clarity_search_usage_rollups',
  {
    ownerAccountId: text('owner_account_id').notNull(),
    applicationId: text('application_id').notNull(),
    credentialId: text('credential_id').notNull().default(''),
    operation: text('operation').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    quantity: bigint('quantity', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'clarity_search_usage_rollups_pk',
      columns: [
        table.ownerAccountId,
        table.applicationId,
        table.credentialId,
        table.operation,
        table.periodStart,
      ],
    }),
  ],
);

export const searchQuotaGrants = pgTable(
  'clarity_search_quota_grants',
  {
    id: text('id').primaryKey(),
    ownerAccountId: text('owner_account_id').notNull(),
    metric: text('metric').notNull(),
    additionalLimit: integer('additional_limit').notNull(),
    reason: text('reason').notNull(),
    grantedBy: text('granted_by').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('clarity_search_quota_grants_account_metric_idx').on(
      table.ownerAccountId,
      table.metric,
      table.expiresAt,
    ),
    check(
      'clarity_search_quota_grants_metric_check',
      sql`${table.metric} in ('search_month', 'fetch_month', 'sites', 'active_crawls', 'pages_per_crawl', 'requests_minute_credential', 'requests_minute_application', 'concurrent_fetches')`,
    ),
    check('clarity_search_quota_grants_limit_check', sql`${table.additionalLimit} > 0`),
  ],
);

export const searchRateLimitBuckets = pgTable(
  'clarity_search_rate_limit_buckets',
  {
    dimension: text('dimension').notNull(),
    dimensionId: text('dimension_id').notNull(),
    bucketStart: timestamp('bucket_start', { withTimezone: true }).notNull(),
    quantity: integer('quantity').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'clarity_search_rate_limit_buckets_pk',
      columns: [table.dimension, table.dimensionId, table.bucketStart],
    }),
    index('clarity_search_rate_limit_buckets_expiry_idx').on(table.expiresAt),
    check(
      'clarity_search_rate_limit_buckets_dimension_check',
      sql`${table.dimension} in ('credential', 'application')`,
    ),
    check('clarity_search_rate_limit_buckets_quantity_check', sql`${table.quantity} > 0`),
  ],
);

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
export const jobClusters = pgTable(
  'clarity_job_clusters',
  {
    id: text('id').primaryKey(),
    /** The member Clarity shows; every other member stays queryable. */
    canonicalJobPostingId: text('canonical_job_posting_id'),
    memberCount: integer('member_count').notNull().default(1),
    ...timestampColumns(),
  },
  (table) => [check('clarity_job_clusters_member_count_check', sql`${table.memberCount} > 0`)],
);

export const jobPostings = pgTable(
  'clarity_job_postings',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => searchDocuments.id, { onDelete: 'cascade' }),
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
    applicantLocationRequirements: text('applicant_location_requirements')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    workplaceType: text('workplace_type'),
    employmentTypes: text('employment_types').array().notNull().default(sql`'{}'::text[]`),
    seniority: text('seniority'),

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
    department: text('department'),
    benefits: text('benefits'),
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
    /**
     * Fingerprint of everything the projection stores except the sighting
     * (`lastSeenAt`, lifecycle status) and extraction times. A listing
     * re-observed with the same fingerprint only records the sighting.
     */
    contentHash: text('content_hash'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestampColumns(),
  },
  (table) => [
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
    index('clarity_job_postings_seniority_idx').on(table.seniority),
    index('clarity_job_postings_skills_idx').using('gin', table.skills),
    index('clarity_job_postings_title_trgm_idx').using('gin', table.title.asc().op('gin_trgm_ops')),
    check(
      'clarity_job_postings_status_check',
      sql`${table.status} in ('active', 'expired', 'closed', 'removed', 'stale')`,
    ),
    check(
      'clarity_job_postings_workplace_check',
      sql`${table.workplaceType} is null or ${table.workplaceType} in ('remote', 'hybrid', 'onsite')`,
    ),
    check(
      'clarity_job_postings_seniority_check',
      sql`${table.seniority} is null or ${table.seniority} in ('intern', 'entry', 'mid', 'senior', 'lead', 'director', 'executive')`,
    ),
    check(
      'clarity_job_postings_source_type_check',
      sql`${table.sourceType} in ('web', 'verified_site', 'first_party', 'feed')`,
    ),
    check(
      'clarity_job_postings_salary_interval_check',
      sql`${table.salaryInterval} is null or ${table.salaryInterval} in ('hour', 'day', 'week', 'month', 'year')`,
    ),
    check(
      'clarity_job_postings_salary_currency_check',
      sql`${table.salaryCurrency} is null or ${table.salaryCurrency} ~ '^[A-Z]{3}$'`,
    ),
  ],
);

/**
 * Grouping evidence. Deleting a row unlinks that evidence without destroying
 * the listing, which is what makes a dedupe decision reversible.
 */
export const jobPostingSignatures = pgTable(
  'clarity_job_posting_signatures',
  {
    jobPostingId: text('job_posting_id')
      .notNull()
      .references(() => jobPostings.id, { onDelete: 'cascade' }),
    signature: text('signature').notNull(),
    kind: text('kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'clarity_job_posting_signatures_pk',
      columns: [table.jobPostingId, table.signature],
    }),
    index('clarity_job_posting_signatures_signature_idx').on(table.signature),
    check(
      'clarity_job_posting_signatures_kind_check',
      sql`${table.kind} in ('identifier', 'listing_url', 'content')`,
    ),
  ],
);

/**
 * Reader reports about a listing (scam, already filled, misleading, …).
 *
 * Deliberately carries NO reporter identity: no user id, no address, no device.
 * A report is an operator signal, never an automatic demotion — reports are not
 * a permitted ranking input, and the Jobs ranker cannot read this table.
 */
export const jobReports = pgTable(
  'clarity_job_reports',
  {
    id: text('id').primaryKey(),
    jobPostingId: text('job_posting_id')
      .notNull()
      .references(() => jobPostings.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    detail: text('detail'),
    status: text('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('clarity_job_reports_status_created_idx').on(table.status, table.createdAt),
    index('clarity_job_reports_posting_idx').on(table.jobPostingId),
    check(
      'clarity_job_reports_reason_check',
      sql`${table.reason} in ('scam', 'already_filled', 'duplicate', 'misleading', 'discriminatory', 'other')`,
    ),
    check(
      'clarity_job_reports_status_check',
      sql`${table.status} in ('open', 'reviewed', 'actioned', 'dismissed')`,
    ),
  ],
);

/**
 * Keyless public listing endpoints Clarity polls for jobs.
 *
 * Sources are DATA, not a hardcoded list: adding a company's board or a feed is
 * a row, not a deploy, and nothing here assumes every job comes from an ATS.
 * No column holds a credential, because every supported kind is a public
 * endpoint that needs none — Clarity registers with nobody to read a public
 * board, and the listing's own URL stays its canonical source.
 */
export const jobFeeds = pgTable(
  'clarity_job_feeds',
  {
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
    /**
     * Where the backfill walk of a paginated source resumes: the provider's own
     * opaque page token or offset, or null when the last walk reached the end.
     * Every poll still reads the newest page first, so new listings never wait
     * for a deep walk to finish.
     */
    cursor: text('cursor'),
    /**
     * The feed whose listings linked to this board, when Clarity registered it
     * by discovery rather than an operator registering it.
     */
    discoveredFromFeedId: text('discovered_from_feed_id'),
    ...timestampColumns(),
  },
  (table) => [
    unique('clarity_job_feeds_kind_identifier_unique').on(table.kind, table.identifier),
    index('clarity_job_feeds_due_idx').on(table.enabled, table.nextPollAt),
    check(
      'clarity_job_feeds_kind_check',
      sql`${table.kind} in ('greenhouse', 'lever', 'lever_eu', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'personio', 'breezy', 'gem', 'pinpoint', 'teamtailor', 'manatal', 'rippling', 'bamboohr', 'polymer', 'workday', 'remoteok', 'remotive', 'arbeitnow', 'aidevboard', 'jobicy', 'workingnomads', 'devitjobs', 'artificialintelligencejobs', 'freehire', 'fourdayweek', 'jobtech', 'weworkremotely', 'oracle', 'phenom', 'eightfold', 'successfactors', 'jobvite', 'hireology', 'softgarden', 'jibe', 'homerun', 'madgex', 'getonboard', 'eures', 'feinaactiva', 'karrierenrw', 'jobsadminch', 'rss', 'rss_jsonld', 'sitemap', 'indeed_xml', 'dvinci', 'hrmanager', 'eploy', 'jobscore', 'keka', 'hirehive', 'emply', 'easycruit', 'zvoove', 'jobsoid', 'kalibrr', 'hiringthing', 'trakstar', 'crelate', 'wp_job_manager', 'directory', 'jobboardly', 'jobbnorge', 'pageup')`,
    ),
    check(
      'clarity_job_feeds_status_check',
      sql`${table.lastStatus} is null or ${table.lastStatus} in ('ok', 'error')`,
    ),
    check('clarity_job_feeds_interval_check', sql`${table.pollIntervalSeconds} >= 900`),
    check('clarity_job_feeds_listings_check', sql`${table.listingsSeen} >= 0`),
  ],
);

/**
 * Which feed delivered which listing document, and when it last did. A source
 * that lists its whole board on every poll proves a listing withdrawn by no
 * longer listing it; this is the record that makes that inference possible
 * (search/jobs/feeds/presence.ts). Removing either side removes the link.
 */
export const jobFeedListings = pgTable(
  'clarity_job_feed_listings',
  {
    feedId: text('feed_id')
      .notNull()
      .references(() => jobFeeds.id, { onDelete: 'cascade' }),
    documentId: text('document_id')
      .notNull()
      .references(() => searchDocuments.id, { onDelete: 'cascade' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.feedId, table.documentId] }),
    index('clarity_job_feed_listings_document_idx').on(table.documentId),
  ],
);

/**
 * Places — the canonical gazetteer job locations resolve against.
 *
 * Keyed by GeoNames id and populated by `bun run places:import` from the
 * GeoNames `cities15000` and `admin1CodesASCII` dumps (CC BY 4.0, attributed in
 * NOTICE). It is reference data, never written from a request. A listing's
 * `locations[].placeId` points here; the raw text the source wrote is kept
 * alongside it.
 */
export const places = pgTable(
  'clarity_places',
  {
    /** GeoNames id. */
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    asciiName: text('ascii_name').notNull(),
    /** Folded (lowercase, accentless) ascii name, for prefix search. */
    searchName: text('search_name').notNull(),
    /** Folded name, ascii name and GeoNames alternate names, for exact resolution. */
    matchNames: text('match_names').array().notNull().default(sql`'{}'::text[]`),
    countryCode: text('country_code').notNull(),
    admin1Code: text('admin1_code'),
    admin1Name: text('admin1_name'),
    /** ISO 3166-2, only where GeoNames' admin1 code already is that code. */
    subdivisionCode: text('subdivision_code'),
    /** GeoNames population; null where GeoNames states none (regions). */
    population: bigint('population', { mode: 'number' }),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    timezone: text('timezone'),
    featureCode: text('feature_code'),
    /** GeoNames' own modification date for the row. */
    sourceModifiedAt: timestamp('source_modified_at', { withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    index('clarity_places_country_kind_idx').on(table.countryCode, table.kind),
    index('clarity_places_search_name_prefix_idx').on(
      table.searchName.asc().op('text_pattern_ops'),
    ),
    index('clarity_places_search_name_trgm_idx').using(
      'gin',
      table.searchName.asc().op('gin_trgm_ops'),
    ),
    index('clarity_places_match_names_idx').using('gin', table.matchNames),
    index('clarity_places_population_idx').on(table.population),
    check('clarity_places_kind_check', sql`${table.kind} in ('city', 'region')`),
    check('clarity_places_country_code_check', sql`${table.countryCode} ~ '^[A-Z]{2}$'`),
    check(
      'clarity_places_population_check',
      sql`${table.population} is null or ${table.population} >= 0`,
    ),
  ],
);

/** User-published work history. Never indexed or joined into Clarity Jobs. */
export const experience = pgTable(
  'clarity_experience',
  {
    id: text('id').primaryKey(),
    oxyUserId: text('oxy_user_id').notNull(),
    title: text('title').notNull(),
    employerOxyAccountId: text('employer_oxy_account_id').notNull(),
    employmentType: text('employment_type'),
    location: text('location'),
    startDate: text('start_date').notNull(),
    endDate: text('end_date'),
    description: text('description'),
    ...timestampColumns(),
  },
  (table) => [
    index('clarity_experience_user_start_idx').on(table.oxyUserId, table.startDate),
    check(
      'clarity_experience_start_month_check',
      sql`${table.startDate} ~ '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])$'`,
    ),
    check(
      'clarity_experience_end_month_check',
      sql`${table.endDate} is null or ${table.endDate} ~ '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])$'`,
    ),
    check(
      'clarity_experience_period_check',
      sql`${table.endDate} is null or ${table.endDate} >= ${table.startDate}`,
    ),
    check(
      'clarity_experience_employment_type_check',
      sql`${table.employmentType} is null or ${table.employmentType} in ('full-time', 'part-time', 'self-employed', 'freelance', 'contract', 'internship', 'apprenticeship', 'seasonal')`,
    ),
  ],
);

/** Minimal deletion tombstone prevents late sessions from recreating erased history. */
export const experienceErasures = pgTable('clarity_experience_erasures', {
  oxyUserId: text('oxy_user_id').primaryKey(),
  eventId: text('event_id').notNull(),
  erasedAt: timestamp('erased_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Durable position in Oxy's signed account-lifecycle reconciliation feed. */
export const accountEventCursors = pgTable('clarity_account_event_cursors', {
  applicationId: text('application_id').primaryKey(),
  cursor: text('cursor'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The durable answer to "did this capability tool call already happen?"
 * (`capabilities/effect-receipts.ts`).
 *
 * Alia may retry an effectful catalogue tool with the same `Idempotency-Key`
 * after a network error or a replayed turn. The second call must return what
 * the first did, not do it again: a second feedback message, a second
 * experience entry, a second job report.
 *
 * One row per (account, tool, key hash). The row is CLAIMED as `pending`
 * before the effect runs, so two concurrent calls cannot both execute; it
 * becomes `completed` with the tool's result, and a failed effect deletes its
 * claim so an honest retry can run. The key itself is never stored, only its
 * SHA-256, and the input's digest is kept so a key reused with DIFFERENT input
 * is refused instead of replaying an unrelated answer. Rows expire after 30
 * days (the worker's maintenance pass deletes them) and go with the account
 * when Oxy reports it deleted.
 */
export const capabilityEffectReceipts = pgTable(
  'clarity_capability_effect_receipts',
  {
    id: text('id').primaryKey(),
    oxyUserId: text('oxy_user_id').notNull(),
    tool: text('tool').notNull(),
    idempotencyKeyHash: text('idempotency_key_hash').notNull(),
    inputDigest: text('input_digest').notNull(),
    status: text('status').notNull().default('pending'),
    result: jsonb('result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('clarity_capability_effect_receipts_key_unique').on(
      table.oxyUserId,
      table.tool,
      table.idempotencyKeyHash,
    ),
    index('clarity_capability_effect_receipts_expires_idx').on(table.expiresAt),
    check(
      'clarity_capability_effect_receipts_status_check',
      sql`${table.status} in ('pending', 'completed')`,
    ),
    check(
      'clarity_capability_effect_receipts_completed_check',
      sql`(${table.status} = 'completed') = (${table.completedAt} is not null and ${table.result} is not null)`,
    ),
  ],
);
