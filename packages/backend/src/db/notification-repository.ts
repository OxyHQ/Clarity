import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { getDb } from './index.js';
import { notifications, pushTokens, webPushSubscriptions } from './schema/index.js';

export type NotificationRow = typeof notifications.$inferSelect;
export type PushTokenRow = typeof pushTokens.$inferSelect;
export type WebPushSubscriptionRow = typeof webPushSubscriptions.$inferSelect;

export type NotificationType =
  | 'trigger_result' | 'proactive_insight' | 'daily_briefing' | 'price_alert'
  | 'integration_event' | 'reminder' | 'agent_task_complete'
  | 'chat_response_ready' | 'oxy_service';
export type NotificationChannel = 'push' | 'telegram' | 'discord' | 'whatsapp' | 'slack' | 'in_app';
export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

export async function listNotifications(input: {
  oxyUserId: string;
  status?: string;
  type?: string;
  limit: number;
  offset: number;
}): Promise<{ rows: NotificationRow[]; total: number }> {
  const conditions = [eq(notifications.oxyUserId, input.oxyUserId)];
  if (input.status) conditions.push(eq(notifications.status, input.status));
  if (input.type) conditions.push(eq(notifications.type, input.type));
  const where = and(...conditions);
  const [rows, countRows] = await Promise.all([
    getDb().select().from(notifications).where(where)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(input.limit).offset(input.offset),
    getDb().select({ count: sql<number>`count(*)::int` }).from(notifications).where(where),
  ]);
  return { rows, total: countRows[0]?.count ?? 0 };
}

export async function createNotification(input: {
  oxyUserId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  channels: NotificationChannel[];
  deliveryStatus: Record<string, 'pending' | 'sent' | 'failed'>;
  status: string;
  priority: NotificationPriority;
  triggerId?: string;
  conversationId?: string;
  expiresAt?: Date;
}): Promise<NotificationRow> {
  const [row] = await getDb().insert(notifications).values({
    id: randomUUID(),
    oxyUserId: input.oxyUserId,
    type: input.type,
    title: input.title,
    body: input.body,
    data: input.data ?? null,
    channels: input.channels,
    deliveryStatus: input.deliveryStatus,
    status: input.status,
    priority: input.priority,
    triggerId: input.triggerId ?? null,
    conversationId: input.conversationId ?? null,
    expiresAt: input.expiresAt ?? null,
  }).returning();
  if (!row) throw new Error('notification insert returned no row');
  return row;
}

export async function updateDeliveryStatus(
  id: string,
  deliveryStatus: Record<string, 'pending' | 'sent' | 'failed'>,
): Promise<void> {
  await getDb().update(notifications).set({ deliveryStatus, updatedAt: new Date() })
    .where(eq(notifications.id, id));
}

export async function getUnreadCount(oxyUserId: string): Promise<number> {
  const [row] = await getDb().select({ count: sql<number>`count(*)::int` }).from(notifications).where(and(
    eq(notifications.oxyUserId, oxyUserId),
    inArray(notifications.status, ['pending', 'sent']),
  ));
  return row?.count ?? 0;
}

export async function markAsRead(id: string, oxyUserId: string): Promise<boolean> {
  const result = await getDb().update(notifications).set({
    status: 'read', readAt: new Date(), updatedAt: new Date(),
  }).where(and(eq(notifications.id, id), eq(notifications.oxyUserId, oxyUserId)));
  return result.count > 0;
}

export async function markAllAsRead(oxyUserId: string): Promise<number> {
  const result = await getDb().update(notifications).set({
    status: 'read', readAt: new Date(), updatedAt: new Date(),
  }).where(and(
    eq(notifications.oxyUserId, oxyUserId),
    inArray(notifications.status, ['pending', 'sent']),
  ));
  return result.count;
}

export async function dismissNotification(id: string, oxyUserId: string): Promise<boolean> {
  const result = await getDb().update(notifications).set({
    status: 'dismissed', updatedAt: new Date(),
  }).where(and(eq(notifications.id, id), eq(notifications.oxyUserId, oxyUserId)));
  return result.count > 0;
}

export async function upsertPushToken(input: {
  oxyUserId: string;
  token: string;
  deviceId?: string;
  platform?: 'ios' | 'android' | 'web';
}): Promise<PushTokenRow> {
  const [row] = await getDb().insert(pushTokens).values({
    id: randomUUID(), oxyUserId: input.oxyUserId, token: input.token,
    deviceId: input.deviceId ?? null, platform: input.platform ?? null, active: true,
  }).onConflictDoUpdate({
    target: [pushTokens.oxyUserId, pushTokens.token],
    set: {
      active: true,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      ...(input.platform ? { platform: input.platform } : {}),
      updatedAt: new Date(),
    },
  }).returning();
  if (!row) throw new Error('push token upsert returned no row');
  return row;
}

export async function deactivatePushToken(oxyUserId: string, token: string): Promise<boolean> {
  const result = await getDb().update(pushTokens).set({ active: false, updatedAt: new Date() })
    .where(and(eq(pushTokens.oxyUserId, oxyUserId), eq(pushTokens.token, token)));
  return result.count > 0;
}

export async function listActivePushTokens(oxyUserId: string): Promise<PushTokenRow[]> {
  return getDb().select().from(pushTokens).where(and(
    eq(pushTokens.oxyUserId, oxyUserId), eq(pushTokens.active, true),
  ));
}

export async function deactivatePushTokenById(id: string): Promise<void> {
  await getDb().update(pushTokens).set({ active: false, updatedAt: new Date() }).where(eq(pushTokens.id, id));
}

export async function touchPushTokens(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await getDb().update(pushTokens).set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(inArray(pushTokens.id, ids));
}

export async function upsertWebPushSubscription(input: {
  oxyUserId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}): Promise<WebPushSubscriptionRow> {
  const [row] = await getDb().insert(webPushSubscriptions).values({
    id: randomUUID(), oxyUserId: input.oxyUserId, endpoint: input.endpoint,
    p256dh: input.p256dh, auth: input.auth, active: true,
  }).onConflictDoUpdate({
    target: [webPushSubscriptions.oxyUserId, webPushSubscriptions.endpoint],
    set: { active: true, p256dh: input.p256dh, auth: input.auth, updatedAt: new Date() },
  }).returning();
  if (!row) throw new Error('web push upsert returned no row');
  return row;
}

export async function deactivateWebPushSubscription(oxyUserId: string, endpoint: string): Promise<boolean> {
  const result = await getDb().update(webPushSubscriptions).set({ active: false, updatedAt: new Date() })
    .where(and(eq(webPushSubscriptions.oxyUserId, oxyUserId), eq(webPushSubscriptions.endpoint, endpoint)));
  return result.count > 0;
}

export async function listActiveWebPushSubscriptions(oxyUserId: string): Promise<WebPushSubscriptionRow[]> {
  return getDb().select().from(webPushSubscriptions).where(and(
    eq(webPushSubscriptions.oxyUserId, oxyUserId), eq(webPushSubscriptions.active, true),
  ));
}

export async function deactivateWebPushSubscriptionById(id: string): Promise<void> {
  await getDb().update(webPushSubscriptions).set({ active: false, updatedAt: new Date() })
    .where(eq(webPushSubscriptions.id, id));
}
