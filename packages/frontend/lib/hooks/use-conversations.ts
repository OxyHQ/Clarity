import { useQuery, useMutation, useQueryClient, useInfiniteQuery, type QueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { toast } from '@/components/sonner';
import { useApiClient } from '../api/use-api-client';
import { queryKeys } from './query-keys';
import type { Message, Conversation, ConversationSource } from '@clarity/shared-types';

const CONVERSATIONS_STORAGE_KEY = "clarity-conversations";

// Fetch all conversations from local storage (offline fallback)
async function fetchConversations(): Promise<Conversation[]> {
  const stored = await AsyncStorage.getItem(CONVERSATIONS_STORAGE_KEY);
  if (stored) {
    return JSON.parse(stored).map((conv: Conversation) => ({
      ...conv,
      createdAt: new Date(conv.createdAt),
      updatedAt: new Date(conv.updatedAt),
    }));
  }
  return [];
}

// Hook to get all conversations with infinite scroll
export function useConversations() {
  const { isAuthenticated } = useOxy();
  const client = useApiClient();

  return useInfiniteQuery({
    queryKey: queryKeys.conversations.all,
    queryFn: async ({ pageParam }: { pageParam?: string }) => {
      try {
        const params: Record<string, unknown> = { limit: 20 };
        if (pageParam) {
          params.cursor = pageParam;
        }

        const response = await client.get<{
          conversations: Array<Conversation & { messages?: Message[] }>;
          nextCursor: string | null;
          hasMore: boolean;
        }>('/conversations', { params });

        return {
          conversations: response.conversations.map((conv) => ({
            ...conv,
            createdAt: new Date(conv.createdAt),
            updatedAt: new Date(conv.updatedAt),
            messages: [] as Message[], // Don't include messages in list view
          })),
          nextCursor: response.nextCursor,
          hasMore: response.hasMore,
        };
      } catch (error: unknown) {
        // If unauthorized, fall back to local storage
        const err = error as { status?: number };
        if (err?.status === 401) {
          const conversations = (await fetchConversations()).map((c) => ({ ...c, messages: [] as Message[] }));
          const offset = pageParam ? parseInt(pageParam) : 0;
          const limit = 20;
          const page = conversations.slice(offset, offset + limit);

          return {
            conversations: page,
            nextCursor: offset + limit < conversations.length ? String(offset + limit) : null,
            hasMore: offset + limit < conversations.length,
          };
        }
        throw error;
      }
    },
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.nextCursor : undefined,
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 2,
    enabled: isAuthenticated,
  });
}

// Hook to get a single conversation with messages
export function useConversation(id: string) {
  const { isAuthenticated } = useOxy();
  const client = useApiClient();

  return useQuery({
    queryKey: queryKeys.conversations.detail(id),
    queryFn: async () => {
      try {
        const data = await client.get<Conversation & { createdAt: string; updatedAt: string }>(`/conversations/${id}`);
        return {
          ...data,
          createdAt: new Date(data.createdAt),
          updatedAt: new Date(data.updatedAt),
        } as Conversation;
      } catch (error: unknown) {
        // If unauthorized or not found on server, fall back to local storage
        const err = error as { status?: number };
        if (err?.status === 401 || err?.status === 404) {
          const stored = await AsyncStorage.getItem(CONVERSATIONS_STORAGE_KEY);
          if (stored) {
            const parsed = JSON.parse(stored);
            const conversation = parsed.find((c: { id: string }) => c.id === id);
            if (conversation) {
              return {
                ...conversation,
                createdAt: new Date(conversation.createdAt),
                updatedAt: new Date(conversation.updatedAt),
              } as Conversation;
            }
          }
        }
        throw new Error('Conversation not found');
      }
    },
    enabled: isAuthenticated && !!id,
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 1,
  });
}

// Prefetch a conversation detail (call from sidebar on press-in / hover)
export function prefetchConversation(queryClient: QueryClient, id: string) {
  // Note: prefetchConversation is called imperatively and cannot use hooks.
  // It relies on the query cache already being populated by useConversation.
  queryClient.prefetchQuery({
    queryKey: queryKeys.conversations.detail(id),
    staleTime: 1000 * 60 * 5,
  });
}

// Save conversation mutation
export function useSaveConversation() {
  const queryClient = useQueryClient();
  const client = useApiClient();

  return useMutation({
    retry: 1,
    mutationFn: async ({
      id,
      messages,
      title,
    }: {
      id: string;
      messages: Message[];
      title?: string;
    }) => {
      const lastMessage = messages[messages.length - 1]?.content?.slice(0, 100);

      try {
        const data = await client.post<{
          id: string;
          title: string;
          lastMessage?: string;
          source?: ConversationSource;
          createdAt: string;
          updatedAt: string;
        }>('/conversations', {
          conversationId: id,
          messages,
          ...(title && { title }),
        });

        return {
          id: data.id,
          title: data.title,
          lastMessage: data.lastMessage,
          source: data.source,
          createdAt: new Date(data.createdAt),
          updatedAt: new Date(data.updatedAt),
          messages,
        };
      } catch (error: unknown) {
        // If unauthorized, save to local storage
        const err = error as { status?: number };
        if (err?.status === 401) {
          const conversations = await fetchConversations();
          const existingIndex = conversations.findIndex((c) => c.id === id);

          const offlineTitle = title || messages.find((m) => m.role === "user")?.content?.slice(0, 50) || "New chat";
          const conversation: Conversation = {
            id,
            title: offlineTitle,
            lastMessage,
            createdAt: existingIndex >= 0 ? conversations[existingIndex].createdAt : new Date(),
            updatedAt: new Date(),
            messages,
          };

          const newConversations = [...conversations];
          if (existingIndex >= 0) {
            newConversations[existingIndex] = conversation;
          } else {
            newConversations.unshift(conversation);
          }

          await AsyncStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(newConversations));
          return conversation;
        }
        throw error;
      }
    },
    onSuccess: (data) => {
      // Update infinite query cache
      queryClient.setQueryData(queryKeys.conversations.all, (oldData: {
        pages: Array<{ conversations: Conversation[]; nextCursor: string | null; hasMore: boolean }>;
        pageParams: unknown[];
      } | undefined) => {
        if (!oldData?.pages) {
          return {
            pages: [{
              conversations: [{ ...data, messages: [] }],
              nextCursor: null,
              hasMore: false,
            }],
            pageParams: [undefined],
          };
        }

        const newPages = [...oldData.pages];
        const conversationMetadata = { ...data, messages: [] };

        // Remove conversation from its current position (if it exists in any page)
        for (let i = 0; i < newPages.length; i++) {
          const existingIndex = newPages[i].conversations.findIndex((c: Conversation) => c.id === data.id);
          if (existingIndex >= 0) {
            newPages[i] = {
              ...newPages[i],
              conversations: [
                ...newPages[i].conversations.slice(0, existingIndex),
                ...newPages[i].conversations.slice(existingIndex + 1),
              ],
            };
            break;
          }
        }

        // Always add to top of first page (most recently updated first)
        if (newPages[0]) {
          newPages[0] = {
            ...newPages[0],
            conversations: [conversationMetadata, ...newPages[0].conversations],
          };
        }

        return {
          ...oldData,
          pages: newPages,
        };
      });

      // Update individual conversation cache with full data including messages
      queryClient.setQueryData(queryKeys.conversations.detail(data.id), data);
    },
    onError: (error: unknown) => {
      const err = error as { message?: string };
      toast.error(err.message || 'Failed to save conversation');
    },
  });
}

// Delete conversation mutation
export function useDeleteConversation() {
  const queryClient = useQueryClient();
  const client = useApiClient();

  return useMutation({
    retry: 1,
    mutationFn: async (id: string) => {
      try {
        await client.delete(`/conversations/${id}`);
      } catch (error: unknown) {
        // If unauthorized, delete from local storage
        const err = error as { status?: number };
        if (err?.status === 401) {
          const conversations = await fetchConversations();
          const newConversations = conversations.filter((c) => c.id !== id);
          await AsyncStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(newConversations));
        } else {
          throw error;
        }
      }
      return id;
    },
    onSuccess: (id) => {
      // Remove from infinite query cache
      queryClient.setQueryData(queryKeys.conversations.all, (oldData: {
        pages: Array<{ conversations: Conversation[] }>;
      } | undefined) => {
        if (!oldData?.pages) return oldData;

        return {
          ...oldData,
          pages: oldData.pages.map((page) => ({
            ...page,
            conversations: page.conversations.filter((c: Conversation) => c.id !== id),
          })),
        };
      });

      // Invalidate individual conversation cache
      queryClient.removeQueries({ queryKey: queryKeys.conversations.detail(id) });
    },
    onError: (error: unknown) => {
      const err = error as { message?: string };
      toast.error(err.message || 'Failed to delete conversation');
    },
  });
}

// Create a new conversation
export function useCreateConversation() {
  const queryClient = useQueryClient();
  const client = useApiClient();

  return useMutation({
    mutationFn: async (params?: { agentId?: string }): Promise<Conversation> => {
      try {
        const data = await client.post<{
          id: string;
          title: string;
          source?: ConversationSource;
          agentId?: string;
          createdAt: string;
          updatedAt: string;
        }>('/conversations/new', {
          ...(params?.agentId && { agentId: params.agentId }),
        });
        return {
          id: data.id,
          title: data.title,
          lastMessage: undefined,
          source: data.source,
          agentId: data.agentId,
          createdAt: new Date(data.createdAt),
          updatedAt: new Date(data.updatedAt),
          messages: [],
        };
      } catch (error: unknown) {
        // If unauthorized, create locally
        const err = error as { status?: number };
        if (err?.status === 401) {
          const { generateUUID } = await import('../utils');
          const id = generateUUID();
          const conversation: Conversation = {
            id,
            title: "New chat",
            lastMessage: undefined,
            createdAt: new Date(),
            updatedAt: new Date(),
            messages: [],
          };

          const conversations = await fetchConversations();
          const newConversations = [conversation, ...conversations];
          await AsyncStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(newConversations));

          return conversation;
        }
        throw error;
      }
    },
    onSuccess: (data) => {
      // Add to first page of infinite query cache
      queryClient.setQueryData(queryKeys.conversations.all, (oldData: {
        pages: Array<{ conversations: Conversation[] }>;
        pageParams: unknown[];
      } | undefined) => {
        if (!oldData?.pages) {
          return {
            pages: [{
              conversations: [data],
              nextCursor: null,
              hasMore: false,
            }],
            pageParams: [undefined],
          };
        }

        const newPages = [...oldData.pages];
        if (newPages[0]) {
          // Check if already exists
          const exists = newPages[0].conversations.some((c: Conversation) => c.id === data.id);
          if (!exists) {
            newPages[0] = {
              ...newPages[0],
              conversations: [data, ...newPages[0].conversations],
            };
          }
        }

        return {
          ...oldData,
          pages: newPages,
        };
      });

      // Set individual conversation cache
      queryClient.setQueryData(queryKeys.conversations.detail(data.id), data);
    },
    onError: (error: unknown) => {
      const err = error as { message?: string };
      toast.error(err.message || 'Failed to create conversation');
    },
  });
}
