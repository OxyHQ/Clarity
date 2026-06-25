import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { useApiClient } from '../api/use-api-client';

interface Notification {
  _id: string;
  type: string;
  title: string;
  body: string;
  status: 'pending' | 'sent' | 'read' | 'dismissed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  data?: Record<string, unknown>;
  triggerId?: string;
  conversationId?: string;
  createdAt: string;
  readAt?: string;
}

interface NotificationsResponse {
  notifications: Notification[];
  total: number;
  unreadCount: number;
}

export function useNotifications(limit = 30) {
  const { isAuthenticated } = useOxy();
  const client = useApiClient();

  return useQuery<NotificationsResponse>({
    queryKey: ['notifications', limit],
    queryFn: () => client.get<NotificationsResponse>('/notifications', { params: { limit } }),
    staleTime: 1000 * 30, // 30 seconds
    refetchInterval: 1000 * 60, // Refresh every minute
    retry: 2,
    enabled: isAuthenticated,
  });
}

export function useUnreadCount() {
  const { isAuthenticated } = useOxy();
  const client = useApiClient();

  return useQuery<{ count: number }>({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => client.get<{ count: number }>('/notifications/unread-count'),
    staleTime: 1000 * 60 * 5, // 5 minutes — socket invalidates on real events
    refetchInterval: false, // rely on socket-driven invalidation
    retry: 1,
    enabled: isAuthenticated,
  });
}

export function useMarkAsRead() {
  const queryClient = useQueryClient();
  const client = useApiClient();

  return useMutation({
    mutationFn: (notificationId: string) =>
      client.patch(`/notifications/${notificationId}/read`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useMarkAllAsRead() {
  const queryClient = useQueryClient();
  const client = useApiClient();

  return useMutation({
    mutationFn: () => client.post('/notifications/read-all'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useDismissNotification() {
  const queryClient = useQueryClient();
  const client = useApiClient();

  return useMutation({
    mutationFn: (notificationId: string) =>
      client.patch(`/notifications/${notificationId}/dismiss`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}
