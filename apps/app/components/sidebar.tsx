import React from "react";
import { View, Pressable, Platform, NativeSyntheticEvent, NativeScrollEvent, Linking } from "react-native";
import { ClarityWordmark } from "@/components/ui/clarity-wordmark";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { BaseSidebar } from "@/components/base-sidebar";
import { Settings2, LogIn, UserPlus, Plus } from "lucide-react-native";
import { useTranslation } from "@/hooks/useTranslation";
import { useStore } from "@/lib/globalStore";
import { useRouter, usePathname } from "expo-router";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { UserAvatar } from "@/components/user-avatar";
import { useOxy } from "@oxyhq/services";
import { SidebarSkeleton } from "@/components/sidebar-skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/hooks/query-keys";
import { useConversations, useDeleteConversation, prefetchConversation } from "@/lib/hooks/use-conversations";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const pathname = usePathname();
  const isSettingsRoute = pathname.startsWith("/settings");
  if (isSettingsRoute) return <SettingsSidebar />;
  return <SearchSidebar />;
}

/* Date grouping helpers */

function isToday(d: Date): boolean {
  return d.toDateString() === new Date().toDateString();
}

function isYesterday(d: Date): boolean {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  return d.toDateString() === y.toDateString();
}

function isThisWeek(d: Date): boolean {
  const now = new Date();
  const sow = new Date(now);
  sow.setDate(now.getDate() - now.getDay());
  sow.setHours(0, 0, 0, 0);
  return d >= sow && !isToday(d) && !isYesterday(d);
}

type ConvLike = { id: string; title: string; updatedAt: Date };

function groupConversations<T extends ConvLike>(convs: T[]) {
  const g = { today: [] as T[], yesterday: [] as T[], thisWeek: [] as T[], older: [] as T[] };
  for (const c of convs) {
    if (isToday(c.updatedAt)) g.today.push(c);
    else if (isYesterday(c.updatedAt)) g.yesterday.push(c);
    else if (isThisWeek(c.updatedAt)) g.thisWeek.push(c);
    else g.older.push(c);
  }
  return g;
}

/* History item — matches reference: group relative block rounded-md select-none */

const SearchHistoryItem = React.memo(function SearchHistoryItem({
  id, title, isActive, onSelect, onPrefetch, onDelete,
}: {
  id: string; title: string; isActive: boolean;
  onSelect: (id: string) => void; onPrefetch: (id: string) => void; onDelete: (id: string) => void;
}) {
  const prefetch = React.useCallback(() => onPrefetch(id), [onPrefetch, id]);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Pressable
          onPress={() => onSelect(id)}
          onPressIn={prefetch}
          // @ts-ignore web-only
          onHoverIn={prefetch}
          className={cn(
            "group relative rounded-md select-none",
            isActive && "bg-muted"
          )}
        >
          {/* Hover background overlay */}
          <View className="absolute rounded-md opacity-0 group-hover:opacity-100 bg-muted inset-0" />
          {/* Text content */}
          <View className="relative flex-row items-center gap-2 pl-1 py-1.5 px-2">
            <View className="w-full overflow-hidden">
              <Text className="text-sm text-foreground" numberOfLines={1}>{title || "New search"}</Text>
            </View>
          </View>
        </Pressable>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <DropdownMenu.Item key="delete" destructive onSelect={() => onDelete(id)}>
          <DropdownMenu.ItemIcon ios={{ name: "trash" }} />
          <DropdownMenu.ItemTitle>Delete</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
});

/* Grouped section — matches reference history-group-label / history-label-text */

function ConversationGroup({ label, items, currentChatId, onSelect, onPrefetch, onDelete }: {
  label: string; items: ConvLike[]; currentChatId: string | undefined;
  onSelect: (id: string) => void; onPrefetch: (id: string) => void; onDelete: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <View className="gap-0.5">
      {/* history-group-label */}
      <View className="gap-1 flex-row items-center justify-between select-none py-1 pl-1 pb-2">
        <View className="min-w-0 flex-row items-center gap-1 w-fit max-w-full">
          <Text className="text-muted-foreground font-medium text-xs hover:text-foreground">{label}</Text>
        </View>
      </View>
      {items.map((c) => (
        <SearchHistoryItem key={c.id} id={c.id} title={c.title} isActive={currentChatId === c.id}
          onSelect={onSelect} onPrefetch={onPrefetch} onDelete={onDelete} />
      ))}
    </View>
  );
}

/* Main sidebar */

const SearchSidebar = React.memo(function SearchSidebar() {
  const router = useRouter();
  const qc = useQueryClient();
  const { t } = useTranslation();
  const chatId = useStore((s) => s.chatId);
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useConversations();
  const deleteMut = useDeleteConversation();
  const { user, isAuthenticated, logout, showBottomSheet } = useOxy();

  const allConvs = React.useMemo(() => {
    const all = data?.pages.flatMap((p) => p.conversations) || [];
    return all.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }, [data]);

  const grouped = React.useMemo(() => groupConversations(allConvs), [allConvs]);

  const handleNewSearch = React.useCallback(() => router.replace("/(app)"), [router]);
  const handleLogoPress = React.useCallback(() => router.replace("/(app)"), [router]);
  const handlePrefetch = React.useCallback((id: string) => prefetchConversation(qc, id), [qc]);

  const handleSelect = React.useCallback((id: string) => {
    if (!qc.getQueryData(queryKeys.conversations.detail(id))) {
      const c = allConvs.find((x) => x.id === id);
      if (c) qc.setQueryData(queryKeys.conversations.detail(id), { ...c, messages: [] }, { updatedAt: 0 });
    }
    prefetchConversation(qc, id);
    router.replace(`/(app)/c/${id}`);
  }, [router, qc, allConvs]);

  const handleDelete = React.useCallback((id: string) => deleteMut.mutate(id), [deleteMut]);
  const handleSettings = React.useCallback(() => router.push("/(app)/settings"), [router]);
  const handleAccount = React.useCallback(() => showBottomSheet("AccountSettings"), [showBottomSheet]);
  const handleLogout = React.useCallback(() => { logout(); router.replace("/login"); }, [router, logout]);
  const handleLogin = React.useCallback(() => router.push("/login"), [router]);
  const handleRegister = React.useCallback(() => router.push("/register"), [router]);
  const handleUpgrade = React.useCallback(() => router.push("/(biglayout)/subscribe"), [router]);

  const displayName = React.useCallback(() => {
    if (!user) return t("common.user");
    if (user.name?.first) return user.name.last ? `${user.name.first} ${user.name.last}` : user.name.first;
    return user.username || t("common.user");
  }, [user, t]);

  const handleScroll = React.useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    if (layoutMeasurement.height + contentOffset.y >= contentSize.height - 100 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  /* Header: logo */
  const header = (
    <Pressable accessibilityLabel="Home" accessibilityRole="button" onPress={handleLogoPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      <ClarityWordmark height={48} />
    </Pressable>
  );

  /* Nav items: New Search button */
  const topSection = (
    <View className="flex-row items-center justify-start no-underline w-full h-8 shrink-0 relative cursor-pointer transition-colors duration-150 gap-1">
      <Pressable
        accessibilityLabel="New search"
        accessibilityRole="button"
        onPress={handleNewSearch}
        className="flex-row items-center gap-2 w-full h-8 rounded-full bg-primary px-3 justify-center"
      >
        <Plus size={16} color="white" />
        <Text className="text-sm font-medium text-primary-foreground">New Search</Text>
      </Pressable>
    </View>
  );

  /* History section — matches: flex min-h-0 w-full flex-1 flex-col overflow-x-hidden overflow-y-auto */
  const scrollableContent = (
    <View className="min-h-0 w-full flex-1 flex-col">
      {isLoading ? <SidebarSkeleton /> : allConvs.length === 0 ? (
        <View className="items-center justify-center py-8">
          <Text className="text-xs text-muted-foreground">No searches yet</Text>
        </View>
      ) : (
        <>
          <ConversationGroup label="Today" items={grouped.today} currentChatId={chatId?.id}
            onSelect={handleSelect} onPrefetch={handlePrefetch} onDelete={handleDelete} />
          <ConversationGroup label="Yesterday" items={grouped.yesterday} currentChatId={chatId?.id}
            onSelect={handleSelect} onPrefetch={handlePrefetch} onDelete={handleDelete} />
          <ConversationGroup label="This Week" items={grouped.thisWeek} currentChatId={chatId?.id}
            onSelect={handleSelect} onPrefetch={handlePrefetch} onDelete={handleDelete} />
          <ConversationGroup label="Older" items={grouped.older} currentChatId={chatId?.id}
            onSelect={handleSelect} onPrefetch={handlePrefetch} onDelete={handleDelete} />
        </>
      )}
    </View>
  );

  /* Footer: user section — matches: mt-auto w-full min-w-0 border-t border-border/50 */
  const footer = (
    <View className="mt-auto w-full min-w-0 border-t border-border/50 flex-col items-center justify-center pt-3">
      {isAuthenticated ? (
        <View className="w-full flex-row justify-start overflow-hidden">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {/* user-button: flex cursor-pointer items-center relative group shrink-0 w-full */}
              <Pressable
                accessibilityLabel="Account menu"
                accessibilityRole="button"
                className="flex-row cursor-pointer items-center relative group shrink-0 w-full gap-2 py-1"
              >
                {/* hover bg */}
                <View className="pointer-events-none absolute bg-muted rounded-md opacity-0 group-hover:opacity-100 transition-opacity duration-150 inset-0" />
                {/* avatar */}
                <View className="relative flex aspect-square shrink-0 items-center justify-center bg-muted rounded-full w-8 h-8">
                  <UserAvatar size={32} />
                </View>
                {/* name */}
                <Text className="text-sm text-foreground leading-tight truncate">{displayName()}</Text>
              </Pressable>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              {Platform.OS === "web" ? (
                <View className="flex-row items-center gap-2.5 px-1.5 py-1.5">
                  <UserAvatar size={36} />
                  <View>
                    <Text className="text-sm font-semibold text-foreground">{displayName()}</Text>
                    {user?.username && <Text className="text-xs text-muted-foreground">{user.username}@oxy.so</Text>}
                  </View>
                </View>
              ) : (
                <DropdownMenu.Label>{displayName()}</DropdownMenu.Label>
              )}
              <DropdownMenu.Separator />
              <DropdownMenu.Item key="upgrade" onSelect={handleUpgrade}>
                <DropdownMenu.ItemIcon ios={{ name: "sparkle" }} />
                <DropdownMenu.ItemTitle>{t("sidebar.upgradeToPro")}</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="account" onSelect={handleAccount}>
                <DropdownMenu.ItemIcon ios={{ name: "person.circle" }} />
                <DropdownMenu.ItemTitle>{t("sidebar.account")}</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="settings" onSelect={handleSettings}>
                <DropdownMenu.ItemIcon ios={{ name: "gearshape" }} />
                <DropdownMenu.ItemTitle>{t("sidebar.settings")}</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item key="terms" onSelect={() => Linking.openURL("https://oxy.so/company/transparency/policies/terms-of-service")}>
                <DropdownMenu.ItemIcon ios={{ name: "doc.text" }} />
                <DropdownMenu.ItemTitle>{t("sidebar.termsOfService")}</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="privacy" onSelect={() => Linking.openURL("https://oxy.so/company/transparency/policies/privacy")}>
                <DropdownMenu.ItemIcon ios={{ name: "hand.raised" }} />
                <DropdownMenu.ItemTitle>{t("sidebar.privacyPolicy")}</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item key="logout" destructive onSelect={handleLogout}>
                <DropdownMenu.ItemIcon ios={{ name: "rectangle.portrait.and.arrow.right" }} />
                <DropdownMenu.ItemTitle>{t("sidebar.logOut")}</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </View>
      ) : (
        <View className="w-full gap-2">
          {/* sign-in-btn: select-none font-medium ... flex w-full rounded-full hover:bg-muted px-3 justify-between */}
          <Pressable
            onPress={handleLogin}
            className="select-none font-medium transition-colors duration-300 text-center items-center justify-center whitespace-nowrap text-foreground border border-solid border-border h-8 text-sm cursor-pointer flex-row w-full rounded-full hover:bg-muted px-3 justify-between"
          >
            <LogIn size={16} className="text-foreground" />
            <Text className="text-sm font-medium text-foreground flex-1 text-center">{t("login.signInButton")}</Text>
          </Pressable>
          <Pressable
            onPress={handleRegister}
            className="select-none font-medium transition-colors duration-300 text-center items-center justify-center whitespace-nowrap text-foreground border border-solid border-border h-8 text-sm cursor-pointer flex-row w-full rounded-full hover:bg-muted px-3 justify-between"
          >
            <UserPlus size={16} className="text-foreground" />
            <Text className="text-sm font-medium text-foreground flex-1 text-center">{t("login.footerLink")}</Text>
          </Pressable>
          <View className="flex-row items-center justify-center gap-1 mt-1">
            <Text className="text-[10px] text-muted-foreground underline"
              onPress={() => Linking.openURL("https://oxy.so/company/transparency/policies/privacy")}>
              {t("sidebar.privacyPolicy")}
            </Text>
            <Text className="text-[10px] text-muted-foreground">{"\u00B7"}</Text>
            <Text className="text-[10px] text-muted-foreground underline"
              onPress={() => Linking.openURL("https://oxy.so/company/transparency/policies/terms-of-service")}>
              {t("sidebar.termsOfService")}
            </Text>
          </View>
        </View>
      )}
    </View>
  );

  return (
    <BaseSidebar header={header} topSection={topSection} navigation={null}
      scrollableContent={scrollableContent} footer={footer} backgroundColor="bg-muted"
      onScroll={handleScroll} showScrollIndicator={false} />
  );
});
