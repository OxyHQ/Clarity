import { z } from 'zod';

import { listNotifications } from '../../db/notification-repository.js';
import {
  dismissNotification,
  getUnreadCount,
  markAllAsRead,
  markAsRead,
} from '../../lib/notification-service.js';
import { type ClarityToolHandlers, notFound, parseInput, requiredString } from './context.js';

const listSchema = z.object({
  status: z.string().optional(),
  type: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(30),
  offset: z.number().int().min(0).default(0),
});

export const NOTIFICATION_HANDLERS: ClarityToolHandlers = {
  listMyNotifications: async (input, { accountId }) => {
    const { status, type, limit, offset } = parseInput(listSchema, input);
    const [listed, unreadCount] = await Promise.all([
      listNotifications({
        oxyUserId: accountId,
        ...(status ? { status } : {}),
        ...(type ? { type } : {}),
        offset,
        limit,
      }),
      getUnreadCount(accountId),
    ]);
    return { notifications: listed.rows, total: listed.total, unreadCount };
  },
  markNotificationRead: async (input, { accountId }) => {
    if (!(await markAsRead(requiredString(input, 'notificationId'), accountId))) {
      throw notFound('notification_not_found', 'Notification not found');
    }
    return { success: true };
  },
  markAllNotificationsRead: async (_input, { accountId }) => ({
    success: true,
    count: await markAllAsRead(accountId),
  }),
  dismissNotification: async (input, { accountId }) => {
    if (!(await dismissNotification(requiredString(input, 'notificationId'), accountId))) {
      throw notFound('notification_not_found', 'Notification not found');
    }
    return { success: true };
  },
};
