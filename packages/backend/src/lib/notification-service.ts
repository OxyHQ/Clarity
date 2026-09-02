/**
 * Notification Service
 *
 * Delivers Clarity-owned notifications through the product channels retained
 * in this service:
 * - in_app: Socket.io real-time event
 * - push: Expo push notifications (mobile)
 *
 * Alia owns messaging-channel delivery and channel webhooks. Historical rows
 * may still name those channels for reconciliation, but this service does not
 * pretend to deliver them.
 */

import Expo, { type ExpoPushMessage, type ExpoPushReceiptId } from 'expo-server-sdk';
import {
  createNotification,
  deactivatePushTokenById,
  deactivateWebPushSubscriptionById,
  dismissNotification as dismissNotificationRow,
  getUnreadCount as countUnreadNotifications,
  listActivePushTokens,
  listActiveWebPushSubscriptions,
  markAllAsRead as markAllNotificationRowsAsRead,
  markAsRead as markNotificationRowAsRead,
  touchPushTokens,
  updateDeliveryStatus,
  type NotificationChannel,
  type NotificationPriority,
  type NotificationRow,
  type NotificationType,
} from '../db/notification-repository.js';
import { webPush, VAPID_PUBLIC_KEY } from './web-push.js';
import { getIO } from '../socket.js';
import { log } from './logger.js';

// ── Expo push singleton ──────────────────────────────────────────────
const expo = new Expo();

function notificationData(notification: NotificationRow): Record<string, unknown> {
  return notification.data && typeof notification.data === 'object' && !Array.isArray(notification.data)
    ? notification.data as Record<string, unknown>
    : {};
}

// ── Types ──────────────────────────────────────────────────────────

export interface SendNotificationOptions {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  priority?: NotificationPriority;
  channels?: NotificationChannel[];
  data?: Record<string, any>;
  triggerId?: string;
  conversationId?: string;
  expiresAt?: Date;
}

// ── Resolve delivery channels ──────────────────────────────────────

/**
 * Determine which channels to deliver a notification to.
 * If explicit channels are provided, use those. Otherwise, default to in_app
 * plus any connected messaging accounts the user has.
 */
async function resolveChannels(userId: string, explicit?: NotificationChannel[]): Promise<NotificationChannel[]> {
  if (explicit && explicit.length > 0) {
    return explicit;
  }

  // Default: always in_app
  const channels: NotificationChannel[] = ['in_app'];

  // Check in parallel: push tokens and web push subscriptions
  const [pushTokens, webPushSubs] = await Promise.all([
    // Push: check if user has any active Expo push tokens
    listActivePushTokens(userId).catch(() => []),

    // Web push: check if user has any active browser push subscriptions (only if VAPID configured)
    VAPID_PUBLIC_KEY
      ? listActiveWebPushSubscriptions(userId).catch(() => [])
      : [],
  ]);

  if (pushTokens.length > 0 || webPushSubs.length > 0) {
    channels.push('push');
  }

  return channels;
}

// ── Channel delivery implementations ───────────────────────────────

async function deliverInApp(notification: NotificationRow): Promise<boolean> {
  const io = getIO();
  if (!io) return false;

  io.to(`user:${notification.oxyUserId}`).emit('notification', {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    priority: notification.priority,
    data: notification.data,
    createdAt: notification.createdAt,
  });

  return true;
}

// ── Expo Push Notifications ─────────────────────────────────────────

/**
 * Deliver a push notification to all of a user's registered Expo push tokens.
 * Handles chunked sending (Expo limit) and async receipt checking.
 */
async function deliverPush(userId: string, notification: NotificationRow): Promise<boolean> {
  const tokens = await listActivePushTokens(userId);

  if (tokens.length === 0) return false;

  // Build messages — one per device token
  const messages: ExpoPushMessage[] = [];
  for (const t of tokens) {
    if (!Expo.isExpoPushToken(t.token)) {
      log.general.warn({ token: t.token, userId }, 'Invalid Expo push token, deactivating');
      await deactivatePushTokenById(t.id);
      continue;
    }

    messages.push({
      to: t.token,
      title: notification.title,
      body: notification.body,
      data: {
        notificationId: notification.id,
        type: notification.type,
        conversationId: notification.conversationId,
        ...notificationData(notification),
      },
      sound: 'default',
      priority: notification.priority === 'urgent' || notification.priority === 'high' ? 'high' : 'normal',
      channelId: 'default',
    });
  }

  if (messages.length === 0) return false;

  // Send in chunks (Expo recommends batches of ~100)
  const chunks = expo.chunkPushNotifications(messages);
  const receiptIds: ExpoPushReceiptId[] = [];
  let anySucceeded = false;

  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);

      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        if (ticket.status === 'ok') {
          anySucceeded = true;
          if (ticket.id) {
            receiptIds.push(ticket.id);
          }
        } else {
          // ticket.status === 'error'
          const errorDetail = ticket as { status: 'error'; message: string; details?: { error: string } };
          log.general.warn(
            { userId, token: chunk[i].to, error: errorDetail.message, errorCode: errorDetail.details?.error },
            'Expo push ticket error',
          );

          // Deactivate tokens that are permanently invalid
          if (errorDetail.details?.error === 'DeviceNotRegistered') {
            const token = tokens.find((candidate) => candidate.token === chunk[i].to);
            if (token) await deactivatePushTokenById(token.id);
          }
        }
      }
    } catch (error) {
      log.general.error({ err: error, userId }, 'Expo push chunk send failed');
    }
  }

  // Fire-and-forget receipt checking (delayed)
  if (receiptIds.length > 0) {
    setTimeout(() => checkPushReceipts(receiptIds).catch(() => {}), 15_000);
  }

  // Update lastUsedAt for active tokens
  if (anySucceeded) {
    const activeTokenIds = tokens.filter(t => Expo.isExpoPushToken(t.token)).map(t => t.id);
    await touchPushTokens(activeTokenIds);
  }

  return anySucceeded;
}

/**
 * Check push notification receipts after a delay.
 * Expo recommends checking ~15 seconds after sending.
 * Deactivates tokens that received DeviceNotRegistered errors.
 */
async function checkPushReceipts(receiptIds: ExpoPushReceiptId[]): Promise<void> {
  const chunks = expo.chunkPushNotificationReceiptIds(receiptIds);

  for (const chunk of chunks) {
    try {
      const receipts = await expo.getPushNotificationReceiptsAsync(chunk);

      for (const [receiptId, receipt] of Object.entries(receipts)) {
        if (receipt.status === 'error') {
          const { message, details } = receipt;
          log.general.warn({ receiptId, message, error: details?.error }, 'Expo push receipt error');

          // Deactivate invalid device tokens
          if (details?.error === 'DeviceNotRegistered') {
            // We can't directly map receiptId -> token, but Expo will stop delivering
            // to unregistered devices. The token gets deactivated on the next send attempt.
            log.general.info({ receiptId }, 'Device not registered — token will be deactivated on next send');
          }
        }
      }
    } catch (error) {
      log.general.error({ err: error }, 'Failed to check Expo push receipts');
    }
  }
}

// ── Web Push Notifications ───────────────────────────────────────────

/**
 * Deliver a push notification to all of a user's registered web push subscriptions.
 * Handles 410 Gone (expired subscription) by deactivating.
 */
async function deliverWebPush(userId: string, notification: NotificationRow): Promise<boolean> {
  if (!VAPID_PUBLIC_KEY) return false;

  const subscriptions = await listActiveWebPushSubscriptions(userId);

  if (subscriptions.length === 0) return false;

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    notificationId: notification.id,
    type: notification.type,
    conversationId: notification.conversationId,
    ...notificationData(notification),
  });

  const results = await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webPush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
      } catch (error: any) {
        if (error?.statusCode === 410 || error?.statusCode === 404) {
          // Subscription expired or invalid — deactivate
          await deactivateWebPushSubscriptionById(sub.id);
          log.general.info({ userId, endpoint: sub.endpoint }, 'Web push subscription expired, deactivated');
        } else {
          log.general.warn({ err: error, userId, endpoint: sub.endpoint }, 'Web push delivery failed');
        }
        throw error; // Re-throw so Promise.allSettled marks as rejected
      }
    }),
  );

  return results.some(r => r.status === 'fulfilled');
}

// ── Main send function ─────────────────────────────────────────────

/**
 * Create and deliver a notification to a user across their preferred channels.
 */
export async function sendNotification(options: SendNotificationOptions): Promise<NotificationRow> {
  const {
    userId,
    type,
    title,
    body,
    priority = 'normal',
    data,
    triggerId,
    conversationId,
    expiresAt,
  } = options;

  const channels = await resolveChannels(userId, options.channels);

  // Persist the notification
  const notification = await createNotification({
    oxyUserId: userId,
    type,
    title,
    body: body.slice(0, 4000), // Cap body length
    data,
    channels,
    deliveryStatus: Object.fromEntries(channels.map(ch => [ch, 'pending'])),
    status: 'sent',
    priority,
    triggerId,
    conversationId,
    expiresAt,
  });

  // Deliver to each channel in parallel
  const deliveryStatus = { ...(notification.deliveryStatus as Record<string, 'pending' | 'sent' | 'failed'>) };
  const deliveries = channels.map(async (channel) => {
    try {
      let success = false;

      switch (channel) {
        case 'in_app':
          success = await deliverInApp(notification);
          break;
        case 'push': {
          // Deliver to both Expo (mobile) and web push in parallel
          const [expoPushOk, webPushOk] = await Promise.all([
            deliverPush(userId, notification),
            deliverWebPush(userId, notification),
          ]);
          success = expoPushOk || webPushOk;
          break;
        }
      }

      deliveryStatus[channel] = success ? 'sent' : 'failed';
    } catch (error: unknown) {
      log.general.error({ err: error, channel, userId }, 'Notification delivery failed');
      deliveryStatus[channel] = 'failed';
    }
  });

  await Promise.allSettled(deliveries);

  // Persist delivery status
  await updateDeliveryStatus(notification.id, deliveryStatus);

  log.general.info(
    { type, userId, channels, title: title.slice(0, 50) },
    'Notification sent',
  );

  return notification;
}

// ── Query helpers ──────────────────────────────────────────────────

export async function getUnreadCount(userId: string): Promise<number> {
  return countUnreadNotifications(userId);
}

export async function markAsRead(notificationId: string, userId: string): Promise<boolean> {
  return markNotificationRowAsRead(notificationId, userId);
}

export async function markAllAsRead(userId: string): Promise<number> {
  return markAllNotificationRowsAsRead(userId);
}

export async function dismissNotification(notificationId: string, userId: string): Promise<boolean> {
  return dismissNotificationRow(notificationId, userId);
}
