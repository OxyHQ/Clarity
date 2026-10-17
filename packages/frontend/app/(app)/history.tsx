import React, { useState, useMemo, useCallback } from 'react';
import {
  View,
  Pressable,
  ScrollView,
  TextInput,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  ActivityIndicator,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Search,
  Plus,
  MoreHorizontal,
  Clock,
  ChevronDown,
  ArrowLeft,
  Trash2,
} from 'lucide-react-native';
import { useTranslation } from '@/hooks/useTranslation';
import { useColorScheme } from '@/lib/useColorScheme';
import {
  aliaQueryKeys,
  type Conversation,
  useConversations,
  useDeleteConversation,
} from '@alia.onl/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { CLARITY_AGENT_ID, conversationPath } from '@/lib/clarity-agent';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { bloomIcon, MenuRowIcon } from '@/lib/bloom-icon';
import { Button, GlyphButton } from '@oxy.so/bloom/button';

/* ================================================================
   Types
   ================================================================ */

type SortOrder = 'newest' | 'oldest';

/* ================================================================
   Relative timestamp helper
   ================================================================ */

function relativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

/* ================================================================
   Sort dropdown
   ================================================================ */

function SortDropdown({ value, onChange }: { value: SortOrder; onChange: (v: SortOrder) => void }) {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild label={t('history.sort')}>
        <Button appearance="outline" tone="neutral" size="xs" trailingIcon={bloomIcon(ChevronDown)}>
          {`${t('history.sort')}: ${t(`history.sort_${value}`)}`}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as SortOrder)}>
          <DropdownMenuRadioItem value="newest">{t('history.sort_newest')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="oldest">{t('history.sort_oldest')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ================================================================
   Thread item
   ================================================================ */

const ThreadItem = React.memo(function ThreadItem({
  conversation,
  onNavigate,
  onDelete,
}: {
  conversation: Conversation;
  onNavigate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();

  const preview = conversation.lastMessage ?? '';

  return (
    <View className="py-4 flex-row items-center border-b border-border/50">
      <View className="gap-y-2 flex-1 flex-col">
        {/* Title + actions row */}
        <View className="flex-row justify-between">
          <Pressable
            onPress={() => onNavigate(conversation.id)}
            className="flex-1 overflow-hidden cursor-pointer"
          >
            <Text className="font-sans text-base font-medium text-foreground" numberOfLines={1}>
              {conversation.title || t('sidebar.newSearch')}
            </Text>
            {preview.length > 0 && (
              <Text className="mt-0.5 font-sans text-sm text-muted-foreground" numberOfLines={2}>
                {preview}
              </Text>
            )}
          </Pressable>

          {/* Actions dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild label={t('actions.more')}>
              <GlyphButton
                size={28}
                glyphSize={14}
                icon={bloomIcon(MoreHorizontal)}
                accessibilityLabel={t('actions.more')}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                tone="danger"
                leading={<MenuRowIcon icon={Trash2} tone="danger" />}
                onPress={() => onDelete(conversation.id)}
              >
                {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </View>

        {/* Metadata row */}
        <View className="mt-1 flex-row items-center">
          <View className="flex-row items-center gap-1">
            <Clock size={14} color={colors.mutedForeground} />
            <Text className="text-xs text-muted-foreground font-sans font-medium">
              {relativeTime(conversation.updatedAt)}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
});

/* ================================================================
   Empty state
   ================================================================ */

function EmptyState() {
  const { t } = useTranslation();

  return (
    <View className="items-center justify-center py-16 px-6">
      <Clock size={32} className="text-muted-foreground mb-3" />
      <Text className="text-base font-medium text-foreground mb-1">{t('history.empty_title')}</Text>
      <Text className="text-sm text-muted-foreground text-center">
        {t('history.empty_threads')}
      </Text>
    </View>
  );
}

/* ================================================================
   Main History screen
   ================================================================ */

export default function HistoryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { colors } = useColorScheme();

  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');

  // Clarity's conversations are Alia's, with Clarity's agent.
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useConversations({
    agentId: CLARITY_AGENT_ID,
  });
  const queryClient = useQueryClient();
  const { mutate: deleteConversation } = useDeleteConversation();

  // Flatten and sort all conversations
  const allConversations = useMemo(() => {
    const all = data?.pages.flatMap((p) => p.conversations) ?? [];
    const sorted = [...all].sort((a, b) => {
      if (sortOrder === 'newest') return b.updatedAt.getTime() - a.updatedAt.getTime();
      return a.updatedAt.getTime() - b.updatedAt.getTime();
    });
    return sorted;
  }, [data, sortOrder]);

  // Apply search filter
  const filteredConversations = useMemo(() => {
    if (!searchQuery.trim()) return allConversations;
    const query = searchQuery.toLowerCase();
    return allConversations.filter((conv) => conv.title?.toLowerCase().includes(query));
  }, [allConversations, searchQuery]);

  const handleNavigate = useCallback(
    (id: string) => {
      router.push(conversationPath(id));
    },
    [router],
  );

  const handleDelete = useCallback(
    (id: string) => {
      deleteConversation(id, {
        onSuccess: () =>
          queryClient.invalidateQueries({
            queryKey: aliaQueryKeys.conversations.filtered({ agentId: CLARITY_AGENT_ID }),
          }),
      });
    },
    [deleteConversation, queryClient],
  );

  const handleNewThread = useCallback(() => {
    router.push('/(app)');
  }, [router]);

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
      if (
        layoutMeasurement.height + contentOffset.y >= contentSize.height - 100 &&
        hasNextPage &&
        !isFetchingNextPage
      ) {
        fetchNextPage();
      }
    },
    [hasNextPage, isFetchingNextPage, fetchNextPage],
  );

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      {/* ── Header ── */}
      <View className="border-b border-border px-4 md:px-6">
        <View className="flex-row items-center justify-between h-14">
          {/* Left: Back + Title */}
          <View className="flex-row items-center gap-3">
            <View className="md:hidden">
              <GlyphButton
                icon={bloomIcon(ArrowLeft)}
                accessibilityLabel={t('common.back')}
                onPress={handleBack}
              />
            </View>
            <Text className="font-sans text-sm font-medium text-foreground select-none">
              {t('history.title')}
            </Text>
          </View>

          {/* Right: New Thread button */}
          <View className="flex-row items-center gap-2">
            <Button
              appearance="outline"
              tone="neutral"
              size="sm"
              leadingIcon={bloomIcon(Plus)}
              onPress={handleNewThread}
            >
              {t('history.newThread')}
            </Button>
          </View>
        </View>
      </View>

      {/* ── Content ── */}
      <ScrollView
        className="flex-1"
        onScroll={handleScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        <View className="w-full max-w-[720px] mx-auto px-4 md:px-6">
          {/* Search bar */}
          <View className="mt-4 flex-row w-full items-center border border-border bg-card h-10 gap-2 rounded-lg px-2 hover:border-border">
            <Search size={16} color={colors.mutedForeground} />
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={t('history.searchPlaceholder')}
              placeholderTextColor={colors.mutedForeground}
              className="flex-1 min-w-0 bg-transparent text-foreground text-sm font-sans web:focus-visible:outline-none"
            />
          </View>

          {/* Filter bar */}
          <View className="flex-row items-center justify-between gap-2 py-4 bg-background">
            <View className="flex-row items-center gap-2">{/* Type filter placeholder */}</View>
            <SortDropdown value={sortOrder} onChange={setSortOrder} />
          </View>

          {/* Thread list or empty state */}
          {isLoading ? (
            <View className="items-center justify-center py-16">
              <ActivityIndicator size="small" color={colors.mutedForeground} />
            </View>
          ) : filteredConversations.length === 0 ? (
            searchQuery.trim() ? (
              <View className="items-center justify-center py-16 px-6">
                <Text className="text-base font-medium text-foreground mb-1">
                  {t('common.noResults')}
                </Text>
                <Text className="text-sm text-muted-foreground text-center">
                  {t('common.tryDifferentSearch')}
                </Text>
              </View>
            ) : (
              <EmptyState />
            )
          ) : (
            <>
              {filteredConversations.map((conv) => (
                <ThreadItem
                  key={conv.id}
                  conversation={conv}
                  onNavigate={handleNavigate}
                  onDelete={handleDelete}
                />
              ))}
              {isFetchingNextPage && (
                <View className="py-4 items-center">
                  <ActivityIndicator size="small" color={colors.mutedForeground} />
                </View>
              )}
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
