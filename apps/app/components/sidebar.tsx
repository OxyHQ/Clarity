import React from "react";
import {
  View,
  Pressable,
  Platform,
  ScrollView,
  NativeSyntheticEvent,
  NativeScrollEvent,
  Linking,
  useWindowDimensions,
} from "react-native";
import { Text } from "@/components/ui/text";
import {
  Search,
  PenSquare,
  Mic,
  Image as ImageIcon,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  MoreVertical,
  Plus,
  FolderOpen,
  Clock,
  Monitor,
} from "lucide-react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
} from "react-native-reanimated";
import { useTranslation } from "@/hooks/useTranslation";
import { useStore } from "@/lib/globalStore";
import { useUIStore } from "@/lib/stores/ui-store";
import { useRouter, usePathname } from "expo-router";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { UserAvatar } from "@/components/user-avatar";
import { useOxy } from "@oxyhq/services";
import { SidebarSkeleton } from "@/components/sidebar-skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/hooks/query-keys";
import {
  useConversations,
  useCreateConversation,
  useDeleteConversation,
  prefetchConversation,
  type Conversation,
} from "@/lib/hooks/use-conversations";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { ClarityWordmark } from "@/components/ui/clarity-wordmark";
import { useColorScheme } from "@/lib/useColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react-native";

/* ================================================================
   Constants
   ================================================================ */

const ANIM_CONFIG = { duration: 200 } as const;
const VISIBLE_HISTORY_COUNT = 8;

/* ================================================================
   Root Sidebar — routes to settings sidebar when on /settings
   ================================================================ */

export function Sidebar() {
  const pathname = usePathname();
  const isSettingsRoute = pathname.startsWith("/settings");
  if (isSettingsRoute) return <SettingsSidebar />;
  return <SearchSidebar />;
}

/* ================================================================
   Mode toggle (Search / Chat segmented control)
   ================================================================ */

/**
 * Vertical two-option segmented control in the sidebar header.
 * A sliding bg-card indicator animates between the two options.
 * The indicator height is (container - 8px padding) / 2, positioned
 * at top (Search) or bottom (Chat) via translateY.
 */
function ModeToggle() {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const sidebarMode = useUIStore((s) => s.sidebarMode);
  const setSidebarMode = useUIStore((s) => s.setSidebarMode);

  const isSearch = sidebarMode !== "computer";

  // Animated translateY for the sliding indicator.
  // 0 = top (search), 32 = bottom (chat).  Each row is h-8 = 32px.
  const indicatorY = useSharedValue(isSearch ? 0 : 32);

  // Keep shared value in sync when store changes externally
  React.useEffect(() => {
    indicatorY.value = withTiming(isSearch ? 0 : 32, ANIM_CONFIG);
  }, [isSearch, indicatorY]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: indicatorY.value }],
  }));

  const handleSearch = React.useCallback(() => setSidebarMode("search"), [setSidebarMode]);
  const handleComputer = React.useCallback(() => setSidebarMode("computer"), [setSidebarMode]);

  return (
    <View className="p-1 relative rounded-xl overflow-hidden" style={{ height: 72 }}>
      {/* Background track */}
      <View className="absolute inset-0 bg-accent/50 rounded-xl" />

      {/* Sliding active indicator */}
      <Animated.View
        className="absolute bg-card rounded-lg"
        style={[
          { top: 4, left: 4, right: 4, height: 32 },
          indicatorStyle,
        ]}
      />

      {/* Search option */}
      <Pressable
        onPress={handleSearch}
        className="group/toggle flex-row items-center justify-start w-full h-8 shrink-0 relative cursor-pointer gap-1"
      >
        <View className="items-center justify-center shrink-0" style={{ width: 32 }}>
          <ClarityWordmark width={20} color={isSearch ? colors.foreground : colors.mutedForeground} />
        </View>
        <Text
          className={cn(
            "font-sans text-sm flex-1",
            isSearch ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {t("sidebar.search")}
        </Text>
        {Platform.OS === "web" && (
          <View className="opacity-0 group-hover/toggle:opacity-100">
            <Text className="mr-4 shrink-0 font-sans text-[10px] font-normal text-muted-foreground/60 select-none">
              {"\u2325\u2303"}1
            </Text>
          </View>
        )}
      </Pressable>

      {/* Computer option */}
      <Pressable
        onPress={handleComputer}
        className="group/toggle flex-row items-center justify-start w-full h-8 shrink-0 relative cursor-pointer gap-1"
      >
        <View className="items-center justify-center shrink-0" style={{ width: 32 }}>
          <Monitor
            size={16}
            className={isSearch ? "text-muted-foreground" : "text-foreground"}
          />
        </View>
        <Text
          className={cn(
            "font-sans text-sm flex-1",
            isSearch ? "text-muted-foreground" : "text-foreground",
          )}
        >
          Computer
        </Text>
        {Platform.OS === "web" && (
          <View className="opacity-0 group-hover/toggle:opacity-100">
            <Text className="mr-4 shrink-0 font-sans text-[10px] font-normal text-muted-foreground/60 select-none">
              {"\u2325\u2303"}2
            </Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

/* ================================================================
   Date grouping helpers
   ================================================================ */

function isToday(date: Date): boolean {
  const now = new Date();
  return (
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear()
  );
}

function isYesterday(date: Date): boolean {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return (
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear()
  );
}

interface DateGroup {
  label: string;
  conversations: Conversation[];
}

function groupByDate(
  conversations: Conversation[],
  t: (key: string) => string,
): DateGroup[] {
  const today: Conversation[] = [];
  const yesterday: Conversation[] = [];
  const earlier: Conversation[] = [];

  for (const conv of conversations) {
    if (isToday(conv.updatedAt)) {
      today.push(conv);
    } else if (isYesterday(conv.updatedAt)) {
      yesterday.push(conv);
    } else {
      earlier.push(conv);
    }
  }

  const groups: DateGroup[] = [];
  if (today.length > 0)
    groups.push({ label: t("sidebar.today"), conversations: today });
  if (yesterday.length > 0)
    groups.push({ label: t("sidebar.yesterday"), conversations: yesterday });
  if (earlier.length > 0)
    groups.push({ label: t("sidebar.earlier"), conversations: earlier });
  return groups;
}

/* ================================================================
   Nav item (expanded + collapsed variants)
   ================================================================ */

interface NavItemProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  shortcut?: string;
  isActive?: boolean;
  collapsed?: boolean;
}

function NavItem({
  icon: Icon,
  label,
  onPress,
  shortcut,
  isActive,
  collapsed,
}: NavItemProps) {
  if (collapsed) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityLabel={label}
        className={cn(
          "group/nav-icon w-10 h-10 rounded-xl items-center justify-center",
          isActive ? "bg-muted" : "hover:bg-muted active:bg-muted/80",
        )}
      >
        <Icon
          size={20}
          className="text-foreground group-hover/nav-icon:scale-110"
        />
      </Pressable>
    );
  }

  return (
    <View className="relative flex w-full min-w-0 flex-col px-1.5 py-0.5 shrink-0">
      <View className="flex w-full min-w-0 flex-col gap-px">
        <View className="group/menu-item whitespace-nowrap font-semibold mx-1 relative">
          <Pressable
            onPress={onPress}
            className={cn(
              "flex-row items-center gap-2 overflow-hidden rounded-xl text-left h-[36px] border border-transparent w-full gap-1 p-1.5",
              isActive
                ? "bg-muted"
                : "hover:bg-muted active:bg-muted/80",
            )}
          >
            <View className="w-6 h-6 flex items-center justify-center shrink-0">
              <Icon size={18} className="text-foreground" />
            </View>
            <Text className="text-sm text-foreground select-none font-semibold">
              {label}
            </Text>
            {shortcut && Platform.OS === "web" && (
              <View className="absolute top-1/2 right-1.5 -translate-y-1/2">
                <Text className="text-xs text-muted-foreground ms-auto mr-2 opacity-0 group-hover/menu-item:opacity-100 select-none">
                  {shortcut}
                </Text>
              </View>
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/* ================================================================
   Date separator line
   ================================================================ */

function DateSeparator({ label }: { label: string }) {
  return (
    <View className="flex-row items-center gap-2 pt-3 pb-1 px-3 opacity-80 mx-1">
      <Text className="text-[11px] text-muted-foreground/60 select-none shrink-0">
        {label}
      </Text>
      <View className="h-px bg-border flex-1" />
    </View>
  );
}

/* ================================================================
   History item with hover options button
   ================================================================ */

const HistoryItem = React.memo(function HistoryItem({
  id,
  title,
  isActive,
  onSelect,
  onPrefetch,
  onDelete,
}: {
  id: string;
  title: string;
  isActive: boolean;
  onSelect: (id: string) => void;
  onPrefetch: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const prefetch = React.useCallback(() => onPrefetch(id), [onPrefetch, id]);

  return (
    <View className="group/menu-item relative whitespace-nowrap font-semibold mx-1">
      <DropdownMenu.Root>
        <View className="flex-row items-center">
          <Pressable
            onPress={() => onSelect(id)}
            onPressIn={prefetch}
            onHoverIn={prefetch}
            className={cn(
              "flex-1 flex-row items-center gap-1.5 overflow-hidden rounded-xl text-left text-sm h-[36px] w-full px-3 py-1.5 font-normal",
              isActive
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            <Text
              className={cn(
                "flex-1 select-none overflow-hidden text-sm",
                isActive ? "text-foreground" : "text-muted-foreground",
              )}
              numberOfLines={1}
            >
              {title || t("sidebar.newSearch")}
            </Text>
          </Pressable>
          <DropdownMenu.Trigger>
            <Pressable className="h-6 w-6 hidden group-hover/menu-item:flex items-center justify-center rounded-md hover:bg-muted shrink-0">
              <MoreVertical size={14} className="text-muted-foreground" />
            </Pressable>
          </DropdownMenu.Trigger>
        </View>
        <DropdownMenu.Content>
          <DropdownMenu.Item
            key="delete"
            destructive
            onSelect={() => onDelete(id)}
          >
            <DropdownMenu.ItemIcon ios={{ name: "trash" }} />
            <DropdownMenu.ItemTitle>
              {t("sidebar.delete")}
            </DropdownMenu.ItemTitle>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </View>
  );
});

/* ================================================================
   Collapsible section header (Projects / History)
   ================================================================ */

function SectionHeader({
  label,
  isOpen,
  onToggle,
}: {
  label: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      onPress={onToggle}
      className="pt-4 pb-1 px-3 w-full mx-1 cursor-pointer"
    >
      <View className="inline-flex flex-row items-center gap-2">
        <ChevronDown
          size={12}
          className="text-foreground"
          style={{
            transform: [{ rotate: isOpen ? "0deg" : "-90deg" }],
          }}
        />
        <Text className="text-xs font-semibold text-foreground select-none">
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

/* ================================================================
   Main search sidebar
   ================================================================ */

const SearchSidebar = React.memo(function SearchSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;

  const chatId = useStore((s) => s.chatId);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const sidebarMode = useUIStore((s) => s.sidebarMode);
  const toggleSidebarCollapsed = useUIStore((s) => s.toggleSidebarCollapsed);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
  } = useConversations();
  const deleteMut = useDeleteConversation();
  const createMut = useCreateConversation();
  const { user, isAuthenticated, logout, showBottomSheet } = useOxy();

  // Section open/closed state
  const [projectsOpen, setProjectsOpen] = React.useState(true);
  const [historyOpen, setHistoryOpen] = React.useState(true);

  // Only allow collapse on large screens
  const isCollapsed = isLargeScreen && sidebarCollapsed;

  const allConvs = React.useMemo(() => {
    const all = data?.pages.flatMap((p) => p.conversations) ?? [];
    return all.sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
  }, [data]);

  const dateGroups = React.useMemo(
    () => groupByDate(allConvs.slice(0, VISIBLE_HISTORY_COUNT), t),
    [allConvs, t],
  );

  const hasMore = allConvs.length > VISIBLE_HISTORY_COUNT || hasNextPage;

  // Handlers — mode-aware primary action
  const handleNewSearch = React.useCallback(
    () => router.replace("/(app)"),
    [router],
  );

  const handleNewChat = React.useCallback(async () => {
    const conv = await createMut.mutateAsync({});
    router.replace(`/(app)/c/${conv.id}`);
  }, [createMut, router]);

  /** The primary action depends on the selected sidebar mode */
  const handlePrimaryAction = React.useCallback(() => {
    if (sidebarMode === "computer") {
      handleNewChat();
    } else {
      handleNewSearch();
    }
  }, [sidebarMode, handleNewChat, handleNewSearch]);

  const handlePrefetch = React.useCallback(
    (id: string) => prefetchConversation(qc, id),
    [qc],
  );
  const handleSelect = React.useCallback(
    (id: string) => {
      if (!qc.getQueryData(queryKeys.conversations.detail(id))) {
        const c = allConvs.find((x) => x.id === id);
        if (c)
          qc.setQueryData(
            queryKeys.conversations.detail(id),
            { ...c, messages: [] },
            { updatedAt: 0 },
          );
      }
      prefetchConversation(qc, id);
      router.replace(`/(app)/c/${id}`);
    },
    [router, qc, allConvs],
  );
  const handleDelete = React.useCallback(
    (id: string) => deleteMut.mutate(id),
    [deleteMut],
  );
  const handleSettings = React.useCallback(
    () => router.push("/(app)/settings"),
    [router],
  );
  const handleAccount = React.useCallback(
    () => showBottomSheet("AccountSettings"),
    [showBottomSheet],
  );
  const handleLogout = React.useCallback(() => {
    logout();
    router.replace("/login");
  }, [router, logout]);
  const handleLogin = React.useCallback(
    () => router.push("/login"),
    [router],
  );
  const handleUpgrade = React.useCallback(
    () => router.push("/(biglayout)/subscribe"),
    [router],
  );

  const handleScroll = React.useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
      if (
        layoutMeasurement.height + contentOffset.y >=
          contentSize.height - 100 &&
        hasNextPage &&
        !isFetchingNextPage
      ) {
        fetchNextPage();
      }
    },
    [hasNextPage, isFetchingNextPage, fetchNextPage],
  );

  const displayName = React.useMemo(() => {
    if (!user) return t("common.user");
    if (user.name?.first)
      return user.name.last
        ? `${user.name.first} ${user.name.last}`
        : user.name.first;
    return user.username || t("common.user");
  }, [user, t]);

  /* ================================================================
     COLLAPSED LAYOUT
     ================================================================ */
  if (isCollapsed) {
    return (
      <View
        className="flex h-full flex-col bg-background border-r border-border items-center"
        style={{
          width: 48,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        }}
      >
        {/* Logo */}
        <View className="h-14 items-center justify-center shrink-0">
          <ClarityWordmark width={20} color={colors.foreground} />
        </View>

        {/* Nav icons */}
        <View className="flex flex-col items-center gap-1 py-1 shrink-0">
          <NavItem
            icon={Search}
            label={t("sidebar.search")}
            onPress={handleNewSearch}
            collapsed
          />
          <NavItem
            icon={PenSquare}
            label={t("sidebar.chat")}
            onPress={handleNewChat}
            collapsed
          />
          <NavItem
            icon={Mic}
            label={t("sidebar.voice")}
            onPress={() => {}}
            collapsed
          />
          <NavItem
            icon={ImageIcon}
            label={t("sidebar.imagine")}
            onPress={() => {}}
            collapsed
          />
        </View>

        {/* Divider */}
        <View className="mx-2 border-t border-border/30 w-8 my-1" />

        {/* Section icons */}
        <View className="flex flex-col items-center gap-1 py-1 shrink-0">
          <NavItem
            icon={FolderOpen}
            label={t("sidebar.projects")}
            onPress={() => {}}
            collapsed
          />
          <NavItem
            icon={Clock}
            label={t("sidebar.history")}
            onPress={() => {}}
            collapsed
          />
        </View>

        {/* Spacer */}
        <View className="flex-1" />

        {/* Footer: expand + avatar */}
        <View className="flex flex-col items-center gap-2 p-2 pt-1 shrink-0">
          <Pressable
            onPress={toggleSidebarCollapsed}
            accessibilityLabel="Expand sidebar"
            className="h-10 w-10 rounded-xl items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            <ChevronsRight size={18} className="text-muted-foreground" />
          </Pressable>
          {isAuthenticated ? (
            <Pressable
              onPress={handleAccount}
              className="rounded-full h-10 w-10 flex p-1 items-center justify-center overflow-visible"
            >
              <UserAvatar size={32} />
            </Pressable>
          ) : (
            <Pressable
              onPress={handleLogin}
              className="rounded-full h-10 w-10 flex items-center justify-center bg-primary/10"
            >
              <Text className="text-sm font-bold text-primary">
                {(t("login.signInButton")[0] || "S").toUpperCase()}
              </Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  /* ================================================================
     EXPANDED LAYOUT
     ================================================================ */
  return (
    <View
      className="flex h-full w-full flex-col bg-background border-r border-border"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      {/* ── Header: logo + collapse button ── */}
      <View className="h-14 flex-row items-center gap-0 shrink-0 relative overflow-hidden px-2">
        {/* Logo */}
        <Pressable onPress={handleNewSearch} className="block w-fit p-1 mx-0.5 shrink-0 hover:bg-muted rounded-xl">
          <ClarityWordmark width={28} color={colors.foreground} />
        </Pressable>

        {/* Collapse toggle — pushed to right */}
        {isLargeScreen && (
          <View className="ms-auto shrink-0">
            <Pressable
              onPress={toggleSidebarCollapsed}
              accessibilityLabel="Collapse sidebar"
              className="h-10 w-10 rounded-xl items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <ChevronsLeft size={18} className="text-muted-foreground" />
            </Pressable>
          </View>
        )}
      </View>

      {/* ── Mode toggle (Search / Chat) ── */}
      <View className="shrink-0 px-2 pb-1">
        <ModeToggle />
      </View>

      {/* ── Nav menu items ── */}
      <View className="shrink-0">
        <NavItem
          icon={Search}
          label={t("sidebar.search")}
          onPress={handleNewSearch}
          shortcut="Ctrl+K"
        />
        <NavItem
          icon={PenSquare}
          label={t("sidebar.chat")}
          onPress={handleNewChat}
          shortcut="Ctrl+J"
        />
        <NavItem
          icon={Mic}
          label={t("sidebar.voice")}
          onPress={() => {}}
        />
        <NavItem
          icon={ImageIcon}
          label={t("sidebar.imagine")}
          onPress={() => {}}
        />
      </View>

      {/* ── Divider ── */}
      <View className="mx-2 border-t border-border/30 my-1" />

      {/* ── Scrollable content: Projects + History ── */}
      <ScrollView
        className="flex min-h-0 flex-col overflow-auto grow relative overflow-y-auto overflow-x-hidden"
        onScroll={handleScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      >
        {/* Projects section */}
        <SectionHeader
          label={t("sidebar.projects")}
          isOpen={projectsOpen}
          onToggle={() => setProjectsOpen((prev) => !prev)}
        />
        {projectsOpen && (
          <View className="px-1.5">
            <Pressable
              onPress={() => {}}
              className="flex-row items-center gap-2 mx-1 px-3 py-1.5 rounded-xl hover:bg-muted"
            >
              <Plus size={14} className="text-muted-foreground" />
              <Text className="text-sm text-muted-foreground select-none">
                {t("sidebar.newProject")}
              </Text>
            </Pressable>
          </View>
        )}

        {/* History section */}
        <SectionHeader
          label={t("sidebar.history")}
          isOpen={historyOpen}
          onToggle={() => setHistoryOpen((prev) => !prev)}
        />
        {historyOpen && (
          <View className="px-1.5">
            {isLoading ? (
              <SidebarSkeleton />
            ) : allConvs.length === 0 ? (
              <View className="items-center justify-center py-8">
                <Text className="text-xs text-muted-foreground">
                  {t("sidebar.noSearches")}
                </Text>
              </View>
            ) : (
              <>
                {dateGroups.map((group) => (
                  <View key={group.label}>
                    <DateSeparator label={group.label} />
                    {group.conversations.map((conv) => (
                      <HistoryItem
                        key={conv.id}
                        id={conv.id}
                        title={conv.title}
                        isActive={chatId?.id === conv.id}
                        onSelect={handleSelect}
                        onPrefetch={handlePrefetch}
                        onDelete={handleDelete}
                      />
                    ))}
                  </View>
                ))}
                {hasMore && (
                  <Pressable
                    onPress={() => fetchNextPage()}
                    className="w-full justify-start px-4 py-1 mt-1 pb-1"
                  >
                    <Text className="text-xs font-semibold text-muted-foreground hover:text-foreground select-none">
                      {t("sidebar.seeAll")}
                    </Text>
                  </Pressable>
                )}
              </>
            )}
          </View>
        )}
      </ScrollView>

      {/* ── Divider ── */}
      <View className="mx-2 border-t border-border/30" />

      {/* ── Footer: user avatar ── */}
      <View className="flex flex-col gap-2 mt-auto shrink-0 p-2 pt-1">
        {isAuthenticated ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <Pressable
                accessibilityLabel="Account menu"
                accessibilityRole="button"
                className="rounded-full h-10 w-10 flex p-1 overflow-visible items-center justify-center"
              >
                <UserAvatar size={32} />
              </Pressable>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              {Platform.OS === "web" ? (
                <View className="flex-row items-center gap-2.5 px-2 py-2">
                  <UserAvatar size={36} />
                  <View>
                    <Text className="text-sm font-semibold text-foreground">
                      {displayName}
                    </Text>
                    {user?.username && (
                      <Text className="text-xs text-muted-foreground">
                        {user.username}@oxy.so
                      </Text>
                    )}
                  </View>
                </View>
              ) : (
                <DropdownMenu.Label>{displayName}</DropdownMenu.Label>
              )}
              <DropdownMenu.Separator />
              <DropdownMenu.Item key="upgrade" onSelect={handleUpgrade}>
                <DropdownMenu.ItemIcon ios={{ name: "sparkle" }} />
                <DropdownMenu.ItemTitle>
                  {t("sidebar.upgradeToPro")}
                </DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="account" onSelect={handleAccount}>
                <DropdownMenu.ItemIcon ios={{ name: "person.circle" }} />
                <DropdownMenu.ItemTitle>
                  {t("sidebar.account")}
                </DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="settings" onSelect={handleSettings}>
                <DropdownMenu.ItemIcon ios={{ name: "gearshape" }} />
                <DropdownMenu.ItemTitle>
                  {t("sidebar.settings")}
                </DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                key="terms"
                onSelect={() =>
                  Linking.openURL(
                    "https://oxy.so/company/transparency/policies/terms-of-service",
                  )
                }
              >
                <DropdownMenu.ItemIcon ios={{ name: "doc.text" }} />
                <DropdownMenu.ItemTitle>
                  {t("sidebar.termsOfService")}
                </DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                key="privacy"
                onSelect={() =>
                  Linking.openURL(
                    "https://oxy.so/company/transparency/policies/privacy",
                  )
                }
              >
                <DropdownMenu.ItemIcon ios={{ name: "hand.raised" }} />
                <DropdownMenu.ItemTitle>
                  {t("sidebar.privacyPolicy")}
                </DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                key="logout"
                destructive
                onSelect={handleLogout}
              >
                <DropdownMenu.ItemIcon
                  ios={{ name: "rectangle.portrait.and.arrow.right" }}
                />
                <DropdownMenu.ItemTitle>
                  {t("sidebar.logOut")}
                </DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        ) : (
          <Pressable
            onPress={handleLogin}
            className="rounded-full h-10 w-10 flex items-center justify-center bg-primary/10"
          >
            <Text className="text-sm font-bold text-primary">
              {(t("login.signInButton")[0] || "S").toUpperCase()}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
});
