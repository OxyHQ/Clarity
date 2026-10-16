import type { CatalogTool } from '@oxy.so/contracts';

import { actTool, enumInput, idInput, integerInput, objectInput, readTool } from './define.js';

/** The person's Clarity notifications. Push and web-push registration are device settings, not tools. */
export const NOTIFICATION_TOOLS: readonly CatalogTool[] = [
  readTool({
    name: 'listMyNotifications',
    description:
      'List the person’s Clarity notifications, newest first, with the total and the unread count. Filter by status or type.',
    capability: 'notifications.read',
    input: objectInput({
      status: enumInput(['pending', 'sent', 'read', 'dismissed']),
      type: { type: 'string', maxLength: 64 },
      limit: integerInput(1, 100),
      offset: integerInput(0, 10_000),
    }),
  }),
  actTool({
    name: 'markNotificationRead',
    description: 'Mark one of the person’s notifications as read. Anyone else’s answers not-found.',
    capability: 'notifications.manage',
    capabilityPackage: 'administer',
    input: objectInput({ notificationId: idInput }, ['notificationId']),
  }),
  actTool({
    name: 'markAllNotificationsRead',
    description: 'Mark all of the person’s notifications as read.',
    capability: 'notifications.manage',
    capabilityPackage: 'administer',
    input: objectInput({}),
  }),
  actTool({
    name: 'dismissNotification',
    description: 'Dismiss one of the person’s notifications. Anyone else’s answers not-found.',
    capability: 'notifications.manage',
    capabilityPackage: 'administer',
    input: objectInput({ notificationId: idInput }, ['notificationId']),
  }),
];
