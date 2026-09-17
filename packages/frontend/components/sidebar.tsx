import React from "react";
import { Linking } from "react-native";
import { Briefcase as BriefcaseIcon, User, Settings2, CreditCard, Palette, MessageSquarePlus, Shield, ArrowLeft } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import type { SidebarNavItem, SidebarTree, SidebarIcon, SidebarProps } from "@oxy.so/bloom/sidebar";
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
import { useOxy, openAccountDialog } from "@oxy.so/services";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/hooks/query-keys";
import {
  useConversations,
  useCreateConversation,
  prefetchConversation,
} from "@/lib/hooks/use-conversations";
import type { HydratedConversation } from "@/lib/hooks/use-conversations";

const VISIBLE_HISTORY_COUNT = 8;

/** Wraps a lucide-react-native icon (size/color) as a Bloom icon (width/height/fill) — Bloom ships no briefcase glyph. */
function adaptLucideIcon(Icon: LucideIcon): SidebarIcon {
  return function AdaptedIcon({ width, height, fill }) {
    return <Icon size={width ?? height ?? 20} color={fill as string | undefined} />;
  };
}
const Briefcase = adaptLucideIcon(BriefcaseIcon);
const Back = adaptLucideIcon(ArrowLeft);
const Account = adaptLucideIcon(User);
const General = adaptLucideIcon(Settings2);
const Billing = adaptLucideIcon(CreditCard);
const Personalization = adaptLucideIcon(Palette);
const Security = adaptLucideIcon(Shield);
const Feedback = adaptLucideIcon(MessageSquarePlus);

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
   Settings sidebar config — a plain nav list, no history/account/modes
   ================================================================ */

export function useSettingsSidebarConfig(): SidebarProps {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();

  const activeId = React.useMemo(() => {
    if (pathname.includes("/settings/general")) return "general";
    if (pathname.includes("/settings/usage")) return "usage";
    if (pathname.includes("/settings/personalization")) return "personalization";
    if (pathname.includes("/settings/security")) return "security";
    if (pathname.includes("/settings/feedback")) return "feedback";
    return "account";
  }, [pathname]);

  const items: SidebarNavItem[] = [
    { key: "back", label: t("common.back"), icon: Back, onPress: () => router.replace("/(app)") },
    { key: "account", label: t("settings.sections.account"), icon: Account, onPress: () => router.push("/(app)/settings") },
    { key: "general", label: t("settings.sections.general"), icon: General, onPress: () => router.push("/(app)/settings/general") },
    { key: "usage", label: t("settings.sections.billing"), icon: Billing, onPress: () => router.push("/(app)/settings/usage") },
    { key: "personalization", label: t("settings.sections.personalization"), icon: Personalization, onPress: () => router.push("/(app)/settings/personalization") },
    { key: "security", label: t("settings.sections.security"), icon: Security, onPress: () => router.push("/(app)/settings/security") },
    { key: "feedback", label: t("settings.sections.feedback"), icon: Feedback, onPress: () => router.push("/(app)/settings/feedback") },
  ];

  return { items, selected: activeId, showThemeToggle: true, showSearch: false };
}

/* ================================================================
   Main search sidebar config — Clarity's real data/handlers
   ================================================================ */

export function useSearchSidebarConfig(): SidebarProps {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();

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

  return {
    items,
    selected,
    onNavigate: (item) => {
      if (allConvs.some((c) => c.id === item.key)) handleSelect(item.key);
    },
    modes: [
      { key: "search", label: t("sidebar.search"), icon: RiSearchLine },
      { key: "computer", label: "Computer", icon: RiComputerLine },
    ],
    mode: sidebarMode,
    onModeChange: (key) => setSidebarMode(key as "search" | "computer"),
    tree: historyTree,
    selectedTreeItem: chatId?.id,
    onTreeItemPress: (item) => handleSelect(item.key),
    collapsed: sidebarCollapsed,
    onCollapsedChange: setSidebarCollapsed,
    team: isAuthenticated
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
      : undefined,
    secondaryItems: isAuthenticated
      ? []
      : [
          { key: "login", label: t("login.signInButton"), icon: RiLoginBoxLine, onPress: handleLogin },
          { key: "register", label: t("login.footerLink"), icon: RiUserAddLine, onPress: handleLogin },
        ],
    searchLabel: t("sidebar.search"),
    searchPlaceholder: t("sidebar.search"),
    noResultsLabel: t("sidebar.noSearches"),
  };
}

