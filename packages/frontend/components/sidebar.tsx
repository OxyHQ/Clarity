import React from "react";
import { View, Pressable, Linking, useWindowDimensions } from "react-native";
import { Briefcase as BriefcaseIcon } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { Sidebar as BloomSidebar } from "@oxy.so/bloom/sidebar";
import type { SidebarNavItem, SidebarTree, SidebarIcon } from "@oxy.so/bloom/sidebar";
import {
  RiSearchLine,
  RiComputerLine,
  RiAddLine,
  RiMic2Line,
  RiImageLine,
  RiEarthLine,
  RiTimeLine,
  RiSparklingLine,
  RiUserLine,
  RiBankCardLine,
  RiNotification3Line,
  RiSettings3Line,
  RiFileTextLine,
  RiShieldLine,
  RiLogoutBoxRLine,
  RiLoginBoxLine,
  RiUserAddLine,
} from "@oxy.so/bloom/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { useStore } from "@/lib/globalStore";
import { useUIStore } from "@/lib/stores/ui-store";
import { useRouter, usePathname } from "expo-router";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { useOxy, openAccountDialog } from "@oxy.so/services";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/hooks/query-keys";
import {
  useConversations,
  useCreateConversation,
  prefetchConversation,
} from "@/lib/hooks/use-conversations";
import type { HydratedConversation } from "@/lib/hooks/use-conversations";
import { ClarityWordmark } from "@/components/ui/clarity-wordmark";
import { useColorScheme } from "@/lib/useColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const VISIBLE_HISTORY_COUNT = 8;

/** Wraps a lucide-react-native icon (size/color) as a Bloom icon (width/height/fill) — Bloom ships no briefcase glyph. */
function adaptLucideIcon(Icon: LucideIcon): SidebarIcon {
  return function AdaptedIcon({ width, height, fill }) {
    return <Icon size={width ?? height ?? 20} color={fill as string | undefined} />;
  };
}
const Briefcase = adaptLucideIcon(BriefcaseIcon);

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
   Date grouping — folds recent conversations into the Bloom tree
   ================================================================ */

function isToday(date: Date): boolean {
  const now = new Date();
  return date.getDate() === now.getDate() && date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
}

function isYesterday(date: Date): boolean {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return date.getDate() === yesterday.getDate() && date.getMonth() === yesterday.getMonth() && date.getFullYear() === yesterday.getFullYear();
}

function relativeMeta(date: Date, t: (key: string) => string): string {
  if (isToday(date)) return t("sidebar.today");
  if (isYesterday(date)) return t("sidebar.yesterday");
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function buildHistoryTree(conversations: HydratedConversation[], t: (key: string) => string): SidebarTree {
  const today: HydratedConversation[] = [];
  const yesterday: HydratedConversation[] = [];
  const earlier: HydratedConversation[] = [];
  for (const conv of conversations) {
    if (isToday(conv.updatedAt)) today.push(conv);
    else if (isYesterday(conv.updatedAt)) yesterday.push(conv);
    else earlier.push(conv);
  }
  const toItems = (list: HydratedConversation[]) =>
    list.map((conv) => ({ key: conv.id, label: conv.title || t("sidebar.newSearch"), meta: relativeMeta(conv.updatedAt, t) }));

  const folders = [
    today.length > 0 ? { key: "today", label: t("sidebar.today"), items: toItems(today), defaultOpen: true } : null,
    yesterday.length > 0 ? { key: "yesterday", label: t("sidebar.yesterday"), items: toItems(yesterday), defaultOpen: true } : null,
    earlier.length > 0 ? { key: "earlier", label: t("sidebar.earlier"), items: toItems(earlier), defaultOpen: true } : null,
  ].filter((f): f is NonNullable<typeof f> => f !== null);

  return { label: t("sidebar.history"), folders };
}

/* ================================================================
   Main search sidebar — Bloom's Sidebar, Clarity's own data/handlers
   ================================================================ */

const SearchSidebar = React.memo(function SearchSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;

  const chatId = useStore((s) => s.chatId);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);
  const sidebarMode = useUIStore((s) => s.sidebarMode);
  const setSidebarMode = useUIStore((s) => s.setSidebarMode);

  const { data } = useConversations();
  const createMut = useCreateConversation();
  const { user, isAuthenticated, logout, showBottomSheet, oxyServices } = useOxy();
  const qc = useQueryClient();

  const allConvs = React.useMemo(() => {
    const all = data?.pages.flatMap((p) => p.conversations) ?? [];
    return all.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }, [data]);

  const historyTree = React.useMemo(
    () => buildHistoryTree(allConvs.slice(0, VISIBLE_HISTORY_COUNT), t),
    [allConvs, t],
  );

  const handleNewSearch = React.useCallback(() => router.replace("/(app)"), [router]);
  const handleNewChat = React.useCallback(async () => {
    const conv = await createMut.mutateAsync();
    router.replace(`/(app)/c/${conv.id}`);
  }, [createMut, router]);
  const handlePrefetch = React.useCallback((id: string) => prefetchConversation(qc, id), [qc]);
  const handleSelect = React.useCallback(
    (id: string) => {
      if (!qc.getQueryData(queryKeys.conversations.detail(id))) {
        const c = allConvs.find((x) => x.id === id);
        if (c) qc.setQueryData(queryKeys.conversations.detail(id), { ...c, messages: [] }, { updatedAt: 0 });
      }
      handlePrefetch(id);
      router.replace(`/(app)/c/${id}`);
    },
    [router, qc, allConvs, handlePrefetch],
  );
  const handleHistory = React.useCallback(() => router.push("/(app)/history"), [router]);
  const handleDiscover = React.useCallback(() => router.push("/(app)/discover"), [router]);
  const handleJobs = React.useCallback(() => router.push("/(app)/jobs"), [router]);
  const handleSettings = React.useCallback(() => router.push("/(app)/settings"), [router]);
  const handleAccount = React.useCallback(() => showBottomSheet?.("ManageAccount"), [showBottomSheet]);
  const handleLogout = React.useCallback(() => { logout(); router.replace("/(app)"); }, [router, logout]);
  const handleLogin = React.useCallback(() => openAccountDialog(), []);
  const handleUpgrade = React.useCallback(() => router.push("/(biglayout)/subscribe"), [router]);
  const handleBilling = React.useCallback(() => router.push("/(app)/settings/usage"), [router]);
  const handleNotifications = React.useCallback(() => router.push("/(app)/notifications"), [router]);

  const items: SidebarNavItem[] = [
    { key: "new-chat", label: t("sidebar.newChat"), icon: RiAddLine, onPress: handleNewChat },
    { key: "voice", label: t("sidebar.voice"), icon: RiMic2Line, onPress: () => {} },
    { key: "imagine", label: t("sidebar.imagine"), icon: RiImageLine, onPress: () => {} },
    { key: "discover", label: t("sidebar.discover"), icon: RiEarthLine, onPress: handleDiscover },
    { key: "jobs", label: t("sidebar.jobs"), icon: Briefcase, onPress: handleJobs },
    { key: "history", label: t("sidebar.history"), icon: RiTimeLine, onPress: handleHistory },
  ];

  const selected = React.useMemo(() => {
    if (allConvs.some((c) => c.id === chatId?.id)) return chatId?.id;
    if (pathname.startsWith("/discover")) return "discover";
    if (pathname.startsWith("/jobs")) return "jobs";
    if (pathname.startsWith("/history")) return "history";
    return undefined;
  }, [allConvs, chatId, pathname]);

  const avatarUrl = user?.avatar ? oxyServices.getFileDownloadUrl(user.avatar, "thumb") : undefined;
  const displayName = user?.name?.displayName || t("common.user");

  return (
    <View
      className="flex h-full w-full flex-col bg-background"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      {/* Brand mark — Bloom's Sidebar has no logo slot of its own */}
      <View className="h-14 flex-row items-center shrink-0 px-3">
        {!sidebarCollapsed && (
          <Pressable onPress={handleNewSearch} accessibilityLabel={t("sidebar.search")}>
            <ClarityWordmark height={24} width={62} color={colors.foreground} />
          </Pressable>
        )}
      </View>

      <View className="min-h-0 flex-1">
        <BloomSidebar
          items={items}
          selected={selected}
          onNavigate={(item) => {
            if (allConvs.some((c) => c.id === item.key)) handleSelect(item.key);
          }}
          modes={[
            { key: "search", label: t("sidebar.search"), icon: RiSearchLine },
            { key: "computer", label: "Computer", icon: RiComputerLine },
          ]}
          mode={sidebarMode}
          onModeChange={(key) => setSidebarMode(key as "search" | "computer")}
          tree={historyTree}
          selectedTreeItem={chatId?.id}
          onTreeItemPress={(item) => handleSelect(item.key)}
          collapsed={isLargeScreen && sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
          mobile={!isLargeScreen}
          fluid={!isLargeScreen}
          team={
            isAuthenticated
              ? {
                  name: displayName,
                  email: user?.email,
                  avatar: avatarUrl ? { source: avatarUrl } : { initials: displayName[0]?.toUpperCase() },
                  footer: { label: "Clarity" },
                  groups: [
                    {
                      id: "account",
                      items: [
                        { key: "upgrade", label: t("sidebar.upgradeToPro"), icon: RiSparklingLine, onPress: handleUpgrade },
                        { key: "account", label: t("sidebar.account"), icon: RiUserLine, onPress: handleAccount },
                        { key: "billing", label: t("sidebar.billing"), icon: RiBankCardLine, onPress: handleBilling },
                        { key: "notifications", label: t("sidebar.notifications"), icon: RiNotification3Line, onPress: handleNotifications },
                        { key: "settings", label: t("sidebar.settings"), icon: RiSettings3Line, onPress: handleSettings },
                      ],
                    },
                    {
                      id: "legal",
                      items: [
                        { key: "terms", label: t("sidebar.termsOfService"), icon: RiFileTextLine, onPress: () => Linking.openURL("https://oxy.so/company/transparency/policies/terms-of-service") },
                        { key: "privacy", label: t("sidebar.privacyPolicy"), icon: RiShieldLine, onPress: () => Linking.openURL("https://oxy.so/company/transparency/policies/privacy") },
                      ],
                    },
                    {
                      id: "session",
                      items: [
                        { key: "logout", label: t("sidebar.logOut"), icon: RiLogoutBoxRLine, onPress: handleLogout },
                      ],
                    },
                  ],
                }
              : undefined
          }
          secondaryItems={
            isAuthenticated
              ? []
              : [
                  { key: "login", label: t("login.signInButton"), icon: RiLoginBoxLine, onPress: handleLogin },
                  { key: "register", label: t("login.footerLink"), icon: RiUserAddLine, onPress: handleLogin },
                ]
          }
          searchLabel={t("sidebar.search")}
          searchPlaceholder={t("sidebar.search")}
          noResultsLabel={t("sidebar.noSearches")}
        />
      </View>
    </View>
  );
});
