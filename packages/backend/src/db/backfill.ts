#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';

import {
  canonicalJson,
  hashIdSet,
  readCutoverManifest,
  resolveDataFile,
  sha256,
  sourceId,
  type CutoverCollection,
  type LocalTarget,
} from './cutover-manifest.js';
import { closePostgres, connectPostgres, getDb, type ClarityExecutor } from './index.js';
import {
  backfillReceipts,
  billingCustomers,
  conversations,
  creditPackages,
  features,
  feedback,
  messages,
  notifications,
  planFeatures,
  plans,
  pushTokens,
  runtimeState,
  subscriptions,
  suggestions,
  webPushSubscriptions,
} from './schema/index.js';

const MAX_LINE_BYTES = 4 * 1024 * 1024;
type SourceRecord = Record<string, unknown>;

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const oid = (value as Record<string, unknown>).$oid;
    if (typeof oid === 'string') return oid;
  }
  throw new Error(`${field} must be a string or extended JSON object ID`);
}

function optionalText(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : text(value, field);
}

function numberValue(value: unknown, field: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  let input = value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const wrapped = value as Record<string, unknown>;
    input = wrapped.$numberInt
      ?? wrapped.$numberLong
      ?? wrapped.$numberDouble
      ?? wrapped.$numberDecimal;
  }
  const parsed = typeof input === 'string' && input.trim() !== '' ? Number(input) : input;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) throw new Error(`${field} must be finite`);
  return parsed;
}

function integer(value: unknown, field: string, fallback?: number): number {
  const parsed = numberValue(value, field, fallback);
  if (!Number.isInteger(parsed)) throw new Error(`${field} must be an integer`);
  return parsed;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('expected boolean');
  return value;
}

function dateValue(value: unknown, field: string, fallback?: Date): Date {
  if (value === undefined && fallback) return fallback;
  let input = value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    input = (value as Record<string, unknown>).$date;
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      input = (input as Record<string, unknown>).$numberLong;
    }
  }
  if (typeof input !== 'string' && typeof input !== 'number') throw new Error(`${field} must be a date`);
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${field} is not a valid date`);
  return parsed;
}

function optionalDate(value: unknown, field: string): Date | null {
  return value === undefined || value === null ? null : dateValue(value, field);
}

function strings(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} must be a string array`);
  }
  return value as string[];
}

function optionalJson(value: unknown): Record<string, unknown> | null {
  return value === undefined || value === null ? null : object(value, 'json value');
}

function parseRecordLine(path: string, lineNumber: number, line: Buffer): SourceRecord | null {
  if (line.length > MAX_LINE_BYTES) {
    throw new Error(`${path}:${lineNumber} exceeds the 4 MiB row cap`);
  }
  if (line.length > 0 && line.at(-1) === 13) line = line.subarray(0, -1);
  const textLine = new TextDecoder('utf-8', { fatal: true }).decode(line);
  if (textLine.trim() === '') return null;
  try {
    return object(JSON.parse(textLine), `${path}:${lineNumber}`);
  } catch (error) {
    throw new Error(`${path}:${lineNumber}: ${error instanceof Error ? error.message : error}`);
  }
}

async function* records(path: string, hash: ReturnType<typeof createHash>): AsyncGenerator<SourceRecord> {
  const input = createReadStream(path);
  let buffered = Buffer.alloc(0);
  let lineNumber = 0;
  for await (const rawChunk of input) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    hash.update(chunk);
    buffered = Buffer.concat([buffered, chunk]);
    let newline = buffered.indexOf(10);
    while (newline !== -1) {
      lineNumber += 1;
      const parsed = parseRecordLine(path, lineNumber, buffered.subarray(0, newline));
      buffered = buffered.subarray(newline + 1);
      if (parsed) yield parsed;
      newline = buffered.indexOf(10);
    }
    if (buffered.length > MAX_LINE_BYTES + 1) {
      throw new Error(`${path}:${lineNumber + 1} exceeds the 4 MiB row cap`);
    }
  }
  if (buffered.length > 0) {
    lineNumber += 1;
    const parsed = parseRecordLine(path, lineNumber, buffered);
    if (parsed) yield parsed;
  }
}

async function insertTarget(
  tx: ClarityExecutor,
  target: LocalTarget,
  row: SourceRecord,
): Promise<boolean> {
  const id = sourceId(row._id);
  const createdAt = dateValue(row.createdAt, 'createdAt');
  // Historical Message documents never had `updatedAt`; every other local
  // collection did. Do not manufacture a timestamp while preserving IDs.
  const updatedAt = target === 'clarity_messages'
    ? createdAt
    : dateValue(row.updatedAt, 'updatedAt');
  switch (target) {
    case 'clarity_conversations':
      return (await tx.insert(conversations).values({
        id,
        oxyUserId: text(row.oxyUserId, 'oxyUserId'),
        conversationId: text(row.conversationId, 'conversationId'),
        title: text(row.title ?? 'New chat', 'title'),
        isManualTitle: booleanValue(row.isManualTitle, false),
        lastMessage: optionalText(row.lastMessage, 'lastMessage'),
        source: text(row.source ?? 'app', 'source'),
        folderId: optionalText(row.folderId, 'folderId'),
        icon: optionalText(row.icon, 'icon'),
        iconColor: optionalText(row.iconColor, 'iconColor'),
        isFavorite: booleanValue(row.isFavorite, false),
        isPublic: booleanValue(row.isPublic, false),
        agentId: optionalText(row.agentId, 'agentId'),
        createdAt,
        updatedAt,
      }).onConflictDoNothing().returning({ id: conversations.id })).length === 1;
    case 'clarity_messages':
      return (await tx.insert(messages).values({
        id,
        messageId: optionalText(row.id, 'id'),
        oxyUserId: text(row.oxyUserId, 'oxyUserId'),
        conversationId: text(row.conversationId, 'conversationId'),
        role: text(row.role, 'role'),
        content: row.content === undefined
          ? (() => { throw new Error('content is required'); })()
          : row.content,
        vote: optionalText(row.vote, 'vote'),
        toolInvocations: Array.isArray(row.toolInvocations) ? row.toolInvocations : [],
        agentInfo: optionalJson(row.agentInfo),
        audioUrl: optionalText(row.audioUrl, 'audioUrl'),
        createdAt,
      }).onConflictDoNothing().returning({ id: messages.id })).length === 1;
    case 'clarity_suggestions':
      return (await tx.insert(suggestions).values({
        id,
        suggestionId: text(row.suggestionId, 'suggestionId'),
        title: text(row.title, 'title'),
        text: text(row.text, 'text'),
        description: optionalText(row.description, 'description'),
        isTemplate: booleanValue(row.isTemplate, false),
        templateVariables: strings(row.templateVariables, 'templateVariables'),
        type: text(row.type, 'type'),
        category: optionalText(row.category, 'category'),
        triggerWords: strings(row.triggerWords, 'triggerWords'),
        scope: text(row.scope ?? 'global', 'scope'),
        oxyUserId: optionalText(row.oxyUserId, 'oxyUserId'),
        language: text(row.language ?? 'en-US', 'language'),
        usageCount: integer(row.usageCount, 'usageCount', 0),
        priority: integer(row.priority, 'priority', 0),
        isBuiltIn: booleanValue(row.isBuiltIn, false),
        isAiGenerated: booleanValue(row.isAIGenerated, false),
        tags: strings(row.tags, 'tags'),
        occupations: strings(row.occupations, 'occupations'),
        interests: strings(row.interests, 'interests'),
        expiresAt: optionalDate(row.expiresAt, 'expiresAt'),
        createdAt,
        updatedAt,
      }).onConflictDoNothing().returning({ id: suggestions.id })).length === 1;
    case 'clarity_plans':
      return (await tx.insert(plans).values({
        id,
        planId: text(row.planId, 'planId'),
        name: text(row.name, 'name'),
        product: text(row.product, 'product'),
        creditsPerMonth: integer(row.creditsPerMonth, 'creditsPerMonth', 0),
        dailyFreeCredits: integer(row.dailyFreeCredits, 'dailyFreeCredits', 300),
        monthlyPrice: integer(row.monthlyPrice, 'monthlyPrice', 0),
        annualPrice: integer(row.annualPrice, 'annualPrice', 0),
        currency: text(row.currency ?? 'usd', 'currency'),
        subtitle: text(row.subtitle ?? '', 'subtitle'),
        creditsLabel: text(row.creditsLabel ?? '', 'creditsLabel'),
        isFeatured: booleanValue(row.isFeatured, false),
        sortOrder: integer(row.sortOrder, 'sortOrder', 0),
        modelIds: strings(row.modelIds, 'modelIds'),
        isActive: booleanValue(row.isActive, true),
        isFree: booleanValue(row.isFree, false),
        stripeProductId: optionalText(row.stripeProductId, 'stripeProductId'),
        stripeMonthlyPriceId: optionalText(row.stripeMonthlyPriceId, 'stripeMonthlyPriceId'),
        stripeAnnualPriceId: optionalText(row.stripeAnnualPriceId, 'stripeAnnualPriceId'),
        description: optionalText(row.description, 'description'),
        notes: optionalText(row.notes, 'notes'),
        createdAt,
        updatedAt,
      }).onConflictDoNothing().returning({ id: plans.id })).length === 1;
    case 'clarity_features':
      return (await tx.insert(features).values({
        id,
        featureId: text(row.featureId, 'featureId'),
        label: text(row.label, 'label'),
        description: optionalText(row.description, 'description'),
        icon: optionalText(row.icon, 'icon'),
        category: text(row.category, 'category'),
        featureType: text(row.featureType ?? 'boolean', 'featureType'),
        sortOrder: integer(row.sortOrder, 'sortOrder', 0),
        isVisibleOnPricing: booleanValue(row.isVisibleOnPricing, true),
        isActive: booleanValue(row.isActive, true),
        createdAt,
        updatedAt,
      }).onConflictDoNothing().returning({ id: features.id })).length === 1;
    case 'clarity_plan_features':
      return (await tx.insert(planFeatures).values({
        id,
        planId: text(row.planId, 'planId'),
        featureId: text(row.featureId, 'featureId'),
        enabled: booleanValue(row.enabled, true),
        limitValue: row.limitValue === undefined ? null : integer(row.limitValue, 'limitValue'),
        displayLabel: optionalText(row.displayLabel, 'displayLabel'),
        displayDescription: optionalText(row.displayDescription, 'displayDescription'),
        createdAt,
        updatedAt,
      }).onConflictDoNothing().returning({ id: planFeatures.id })).length === 1;
    case 'clarity_credit_packages':
      return (await tx.insert(creditPackages).values({
        id,
        packageId: text(row.packageId, 'packageId'),
        name: text(row.name, 'name'),
        credits: integer(row.credits, 'credits'),
        price: integer(row.price, 'price'),
        currency: text(row.currency ?? 'usd', 'currency'),
        stripePriceId: optionalText(row.stripePriceId, 'stripePriceId'),
        sortOrder: integer(row.sortOrder, 'sortOrder', 0),
        isActive: booleanValue(row.isActive, true),
        description: optionalText(row.description, 'description'),
        createdAt,
        updatedAt,
      }).onConflictDoNothing().returning({ id: creditPackages.id })).length === 1;
    case 'clarity_feedback':
      return (await tx.insert(feedback).values({
        id,
        oxyUserId: text(row.oxyUserId, 'oxyUserId'),
        type: text(row.type, 'type'),
        rating: row.rating === undefined ? null : integer(row.rating, 'rating'),
        message: text(row.message, 'message'),
        email: optionalText(row.email, 'email'),
        metadata: optionalJson(row.metadata),
        status: text(row.status ?? 'pending', 'status'),
        createdAt,
        updatedAt,
      }).onConflictDoNothing().returning({ id: feedback.id })).length === 1;
    case 'clarity_notifications':
      return (await tx.insert(notifications).values({
        id,
        oxyUserId: text(row.oxyUserId, 'oxyUserId'),
        type: text(row.type, 'type'),
        title: text(row.title, 'title'),
        body: text(row.body, 'body'),
        data: optionalJson(row.data),
        channels: strings(row.channels, 'channels'),
        deliveryStatus: optionalJson(row.deliveryStatus) ?? {},
        status: text(row.status ?? 'pending', 'status'),
        priority: text(row.priority ?? 'normal', 'priority'),
        triggerId: optionalText(row.triggerId, 'triggerId'),
        conversationId: optionalText(row.conversationId, 'conversationId'),
        expiresAt: optionalDate(row.expiresAt, 'expiresAt'),
        readAt: optionalDate(row.readAt, 'readAt'),
        createdAt,
        updatedAt,
      }).onConflictDoNothing().returning({ id: notifications.id })).length === 1;
    case 'clarity_push_tokens':
      return (await tx.insert(pushTokens).values({
        id,
        oxyUserId: text(row.oxyUserId, 'oxyUserId'),
        token: text(row.token, 'token'),
        deviceId: optionalText(row.deviceId, 'deviceId'),
        platform: optionalText(row.platform, 'platform'),
        active: booleanValue(row.active, true),
        lastUsedAt: optionalDate(row.lastUsedAt, 'lastUsedAt'),
        createdAt,
        updatedAt,
      }).onConflictDoNothing().returning({ id: pushTokens.id })).length === 1;
    case 'clarity_web_push_subscriptions': {
      const keys = object(row.keys, 'keys');
      return (await tx.insert(webPushSubscriptions).values({
        id,
        oxyUserId: text(row.oxyUserId, 'oxyUserId'),
        endpoint: text(row.endpoint, 'endpoint'),
        p256dh: text(keys.p256dh, 'keys.p256dh'),
        auth: text(keys.auth, 'keys.auth'),
        active: booleanValue(row.active, true),
        createdAt,
        updatedAt,
      }).onConflictDoNothing().returning({ id: webPushSubscriptions.id })).length === 1;
    }
    case 'clarity_subscriptions': {
      const plan = object(row.plan, 'plan');
      const oxyUserId = text(row.oxyUserId, 'oxyUserId');
      const stripeCustomerId = text(row.stripeCustomerId, 'stripeCustomerId');
      const inserted = (await tx.insert(subscriptions).values({
        id,
        oxyUserId,
        stripeCustomerId,
        stripeSubscriptionId: text(row.stripeSubscriptionId, 'stripeSubscriptionId'),
        stripePriceId: text(row.stripePriceId, 'stripePriceId'),
        status: text(row.status, 'status'),
        currentPeriodStart: dateValue(row.currentPeriodStart, 'currentPeriodStart'),
        currentPeriodEnd: dateValue(row.currentPeriodEnd, 'currentPeriodEnd'),
        cancelAtPeriodEnd: booleanValue(row.cancelAtPeriodEnd, false),
        planId: optionalText(row.planId ?? plan.planId, 'planId'),
        billingPeriod: text(row.billingPeriod ?? 'monthly', 'billingPeriod'),
        planSnapshot: plan,
        createdAt,
        updatedAt,
      }).onConflictDoNothing().returning({ id: subscriptions.id })).length === 1;
      if (inserted) {
        await tx.insert(billingCustomers).values({
          oxyUserId,
          stripeCustomerId,
          createdAt,
          updatedAt,
        }).onConflictDoNothing();
        const [customer] = await tx.select().from(billingCustomers).where(and(
          eq(billingCustomers.oxyUserId, oxyUserId),
          eq(billingCustomers.stripeCustomerId, stripeCustomerId),
        )).limit(1);
        if (!customer) throw new Error('billing customer identity conflicts with imported subscription');
      }
      return inserted;
    }
  }
}

async function importRecord(
  tx: ClarityExecutor,
  sourceName: string,
  target: LocalTarget,
  row: SourceRecord,
): Promise<'inserted' | 'existing'> {
  const id = sourceId(row._id);
  const sourceHash = sha256(canonicalJson(row));
  const [receipt] = await tx.select().from(backfillReceipts).where(and(
    eq(backfillReceipts.sourceCollection, sourceName),
    eq(backfillReceipts.sourceId, id),
  )).limit(1);
  if (receipt) {
    if (receipt.sourceHash !== sourceHash) {
      throw new Error(`${sourceName}/${id} changed after it was imported`);
    }
    return 'existing' as const;
  }

  if (!await insertTarget(tx, target, row)) {
    throw new Error(`${sourceName}/${id} conflicts with an unreceipted target row`);
  }
  await tx.insert(backfillReceipts).values({
    sourceCollection: sourceName,
    sourceId: id,
    sourceHash,
  });
  return 'inserted' as const;
}

const targetTables = {
  clarity_conversations: conversations,
  clarity_messages: messages,
  clarity_suggestions: suggestions,
  clarity_plans: plans,
  clarity_features: features,
  clarity_plan_features: planFeatures,
  clarity_credit_packages: creditPackages,
  clarity_feedback: feedback,
  clarity_notifications: notifications,
  clarity_push_tokens: pushTokens,
  clarity_web_push_subscriptions: webPushSubscriptions,
  clarity_subscriptions: subscriptions,
} as const;

async function countTarget(target: LocalTarget, executor: ClarityExecutor = getDb()): Promise<number> {
  const [result] = await executor.select({ count: sql<number>`count(*)::int` })
    .from(targetTables[target]);
  return result?.count ?? 0;
}

async function importCollection(manifestPath: string, item: CutoverCollection): Promise<void> {
  if (item.disposition.kind !== 'clarity-postgres') return;
  const disposition = item.disposition;
  const path = resolveDataFile(manifestPath, disposition.dataFile);
  const size = statSync(path).size;
  if (size !== disposition.dataBytes) throw new Error(`${item.sourceName} data size changed`);
  await getDb().transaction(async (tx) => {
    const ids: string[] = [];
    const hash = createHash('sha256');
    for await (const row of records(path, hash)) {
      ids.push(sourceId(row._id));
      await importRecord(tx, item.sourceName, disposition.targetTable, row);
    }
    if (hash.digest('hex') !== disposition.dataSha256) {
      throw new Error(`${item.sourceName} data hash changed`);
    }
    if (ids.length !== item.sourceCount) throw new Error(`${item.sourceName} row count changed`);
    if (hashIdSet(ids) !== item.sourceIdSha256) throw new Error(`${item.sourceName} ID set changed`);

    const receipts = await tx.select({ sourceId: backfillReceipts.sourceId })
      .from(backfillReceipts)
      .where(eq(backfillReceipts.sourceCollection, item.sourceName));
    if (receipts.length !== item.sourceCount || hashIdSet(receipts.map((row) => row.sourceId)) !== item.sourceIdSha256) {
      throw new Error(`${item.sourceName} receipt reconciliation failed`);
    }
    if (await countTarget(disposition.targetTable, tx) !== item.sourceCount) {
      throw new Error(`${item.sourceName} target table is not an exact snapshot`);
    }
  });
}

function localOrder(item: CutoverCollection): number {
  if (item.disposition.kind !== 'clarity-postgres') return Number.MAX_SAFE_INTEGER;
  const target = item.disposition.targetTable;
  if (target === 'clarity_conversations' || target === 'clarity_plans' || target === 'clarity_features') return 0;
  if (target === 'clarity_messages' || target === 'clarity_plan_features') return 1;
  return 0;
}

export async function runBackfill(manifestPath: string, databaseUrl: string): Promise<void> {
  const manifest = readCutoverManifest(manifestPath);
  connectPostgres(databaseUrl);
  try {
    const [existing] = await getDb().select().from(runtimeState)
      .where(eq(runtimeState.id, 'postgres-cutover')).limit(1);
    if (existing?.status === 'cutover') throw new Error('cutover is already attested');
    if (existing && existing.sourceSnapshotHash !== manifest.snapshot.inventorySha256) {
      throw new Error('a different source snapshot is already reconciled');
    }

    for (const item of [...manifest.collections].sort((a, b) => localOrder(a) - localOrder(b))) {
      await importCollection(manifestPath, item);
    }

    const sourceCounts = Object.fromEntries(manifest.collections.map((item) => [
      item.sourceName,
      item.sourceCount,
    ]));
    const targetCounts: Record<string, number> = {};
    for (const item of manifest.collections) {
      targetCounts[item.sourceName] = item.disposition.kind === 'clarity-postgres'
        ? await countTarget(item.disposition.targetTable)
        : item.disposition.receipt.targetCount;
    }
    await getDb().insert(runtimeState).values({
      id: 'postgres-cutover',
      status: 'reconciled',
      sourceSnapshotHash: manifest.snapshot.inventorySha256,
      aliaAgentIdSha256: manifest.runtimeEvidence.aliaAgentIdSha256,
      reconciledAt: new Date(),
      sourceCounts,
      targetCounts,
    }).onConflictDoUpdate({
      target: runtimeState.id,
      set: {
        status: 'reconciled',
        sourceSnapshotHash: manifest.snapshot.inventorySha256,
        aliaAgentIdSha256: manifest.runtimeEvidence.aliaAgentIdSha256,
        reconciledAt: new Date(),
        sourceCounts,
        targetCounts,
        updatedAt: new Date(),
      },
    });
  } finally {
    await closePostgres();
  }
}

function argument(argv: readonly string[], name: string): string {
  const prefix = `--${name}=`;
  const value = argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  runBackfill(argument(argv, 'manifest'), databaseUrl).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
