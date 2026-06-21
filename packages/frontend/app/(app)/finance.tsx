import { useState, useCallback } from "react";
import {
  View,
  ScrollView,
  Pressable,
  TextInput,
  useWindowDimensions,
} from "react-native";
import { Text } from "@/components/ui/text";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ArrowLeft,
  Share2,
  ChevronDown,
  ChevronUp,
  Search,
  TrendingUp,
  TrendingDown,
} from "lucide-react-native";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";

/* ================================================================
   Types
   ================================================================ */

type FinanceTab = "usMarkets" | "crypto" | "earnings" | "predictions";
type SidebarTab = "gainers" | "losers" | "active";

interface TickerCard {
  name: string;
  value: string;
  change: string;
  positive: boolean;
}

interface MarketHeadline {
  id: string;
  title: string;
  description: string;
}

interface NewsCard {
  id: string;
  title: string;
  sourceCount: number;
  publishedAt: string;
  imageUrl: string;
}

interface WatchlistItem {
  ticker: string;
  name: string;
  price: string;
  change: string;
  positive: boolean;
}

interface MoverItem {
  ticker: string;
  name: string;
  price: string;
  change: string;
  positive: boolean;
}

interface SectorItem {
  name: string;
  change: string;
  positive: boolean;
}

/* ================================================================
   Mock Data
   ================================================================ */

const FINANCE_TABS: { id: FinanceTab; label: string }[] = [
  { id: "usMarkets", label: "US Markets" },
  { id: "crypto", label: "Crypto" },
  { id: "earnings", label: "Earnings" },
  { id: "predictions", label: "Predictions" },
];

const TOP_ASSETS: TickerCard[] = [
  { name: "S&P 500 Futures", value: "5,987.50", change: "+0.42%", positive: true },
  { name: "NASDAQ Composite", value: "18,847.28", change: "+0.67%", positive: true },
  { name: "Dow Jones", value: "42,051.06", change: "+0.31%", positive: true },
  { name: "VIX", value: "15.23", change: "-2.81%", positive: false },
];

const MARKET_HEADLINES: MarketHeadline[] = [
  {
    id: "1",
    title: "Federal Reserve holds interest rates steady, signals patience on cuts",
    description:
      "The Federal Reserve maintained its benchmark interest rate at the current level, noting that while inflation has eased, officials want to see more sustained progress before reducing rates. Markets reacted positively to the dovish tone of the statement.",
  },
  {
    id: "2",
    title: "Tech sector rallies as AI spending shows no signs of slowing",
    description:
      "Major technology stocks surged after several companies reported higher-than-expected capital expenditure on AI infrastructure. Analysts project the trend will continue through 2026 as enterprise adoption accelerates.",
  },
  {
    id: "3",
    title: "Oil prices drop on unexpected inventory build in US stockpiles",
    description:
      "Crude oil futures fell after government data showed a larger-than-expected increase in US crude inventories, raising concerns about weakening demand amid global economic uncertainty.",
  },
  {
    id: "4",
    title: "Treasury yields decline as bond market prices in slower growth",
    description:
      "The 10-year Treasury yield slipped to its lowest level in three weeks as investors moved into safe-haven assets. Economic indicators point to moderating growth in the services sector.",
  },
];

const RECENT_NEWS: NewsCard[] = [
  {
    id: "1",
    title: "Apple announces $100B share buyback, largest in corporate history",
    sourceCount: 14,
    publishedAt: "1h ago",
    imageUrl: "https://picsum.photos/seed/apple-buyback/400/266",
  },
  {
    id: "2",
    title: "Bitcoin ETFs see record weekly inflows as institutional interest surges",
    sourceCount: 9,
    publishedAt: "2h ago",
    imageUrl: "https://picsum.photos/seed/bitcoin-etf/400/266",
  },
  {
    id: "3",
    title: "China's manufacturing PMI expands for third consecutive month",
    sourceCount: 11,
    publishedAt: "3h ago",
    imageUrl: "https://picsum.photos/seed/china-pmi/400/266",
  },
  {
    id: "4",
    title: "European banks report strong Q1 earnings, beat analyst expectations",
    sourceCount: 7,
    publishedAt: "4h ago",
    imageUrl: "https://picsum.photos/seed/eu-banks/400/266",
  },
  {
    id: "5",
    title: "Nvidia unveils next-gen AI chip with 2x performance per watt",
    sourceCount: 16,
    publishedAt: "5h ago",
    imageUrl: "https://picsum.photos/seed/nvidia-chip/400/266",
  },
];

const WATCHLIST: WatchlistItem[] = [
  { ticker: "AAPL", name: "Apple Inc.", price: "198.45", change: "+1.23%", positive: true },
  { ticker: "MSFT", name: "Microsoft Corp.", price: "452.18", change: "+0.87%", positive: true },
  { ticker: "GOOGL", name: "Alphabet Inc.", price: "176.92", change: "-0.34%", positive: false },
  { ticker: "AMZN", name: "Amazon.com Inc.", price: "192.67", change: "+1.56%", positive: true },
  { ticker: "TSLA", name: "Tesla Inc.", price: "248.31", change: "-2.14%", positive: false },
];

const GAINERS: MoverItem[] = [
  { ticker: "SMCI", name: "Super Micro", price: "892.40", change: "+12.3%", positive: true },
  { ticker: "PLTR", name: "Palantir", price: "24.87", change: "+8.7%", positive: true },
  { ticker: "RIVN", name: "Rivian", price: "18.42", change: "+6.2%", positive: true },
];

const LOSERS: MoverItem[] = [
  { ticker: "NFLX", name: "Netflix", price: "612.30", change: "-4.1%", positive: false },
  { ticker: "BA", name: "Boeing", price: "178.50", change: "-3.8%", positive: false },
  { ticker: "DIS", name: "Disney", price: "108.20", change: "-2.9%", positive: false },
];

const ACTIVE: MoverItem[] = [
  { ticker: "NVDA", name: "Nvidia", price: "924.50", change: "+3.2%", positive: true },
  { ticker: "TSLA", name: "Tesla", price: "248.31", change: "-2.1%", positive: false },
  { ticker: "AMD", name: "AMD", price: "168.74", change: "+1.8%", positive: true },
];

const SECTORS: SectorItem[] = [
  { name: "Technology", change: "+1.24%", positive: true },
  { name: "Healthcare", change: "+0.56%", positive: true },
  { name: "Finance", change: "-0.31%", positive: false },
  { name: "Energy", change: "-0.87%", positive: false },
  { name: "Consumer", change: "+0.42%", positive: true },
];

const MOVERS_MAP: Record<SidebarTab, MoverItem[]> = {
  gainers: GAINERS,
  losers: LOSERS,
  active: ACTIVE,
};

/* ================================================================
   Accordion Item
   ================================================================ */

function AccordionItem({
  headline,
}: {
  headline: MarketHeadline;
}) {
  const { colors } = useColorScheme();
  const [expanded, setExpanded] = useState(false);

  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const Icon = expanded ? ChevronUp : ChevronDown;

  return (
    <Pressable
      onPress={toggle}
      className="bg-card rounded-xl border border-border p-4"
    >
      <View className="flex-row items-start justify-between gap-3">
        <Text className="flex-1 text-sm font-medium text-foreground leading-snug">
          {headline.title}
        </Text>
        <Icon size={16} color={colors.mutedForeground} />
      </View>
      {expanded && (
        <Text className="mt-3 text-sm text-muted-foreground leading-relaxed">
          {headline.description}
        </Text>
      )}
    </Pressable>
  );
}

/* ================================================================
   Sidebar: Watchlist Card
   ================================================================ */

function WatchlistCard() {
  const { t } = useTranslation();

  return (
    <View className="rounded-xl border border-border bg-card p-4 gap-3">
      <Text className="text-sm font-semibold text-foreground">
        {t("finance.watchlist")}
      </Text>
      {WATCHLIST.map((item) => (
        <View
          key={item.ticker}
          className="flex-row items-center justify-between py-1.5"
        >
          <View className="gap-0.5">
            <Text className="text-sm font-medium text-foreground">
              {item.ticker}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {item.name}
            </Text>
          </View>
          <View className="items-end gap-0.5">
            <Text className="text-sm font-medium text-foreground">
              ${item.price}
            </Text>
            <Text
              className={cn(
                "text-xs font-medium",
                item.positive ? "text-green-500" : "text-red-500",
              )}
            >
              {item.change}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/* ================================================================
   Sidebar: Gainers / Losers / Active Card
   ================================================================ */

function MoversCard() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SidebarTab>("gainers");

  const tabs: { key: SidebarTab; labelKey: string }[] = [
    { key: "gainers", labelKey: "finance.gainers" },
    { key: "losers", labelKey: "finance.losers" },
    { key: "active", labelKey: "finance.active" },
  ];

  const items = MOVERS_MAP[activeTab];

  return (
    <View className="rounded-xl border border-border bg-card p-4 gap-3">
      {/* Tabs */}
      <View className="flex-row items-center gap-1">
        {tabs.map((tab) => (
          <Pressable
            key={tab.key}
            onPress={() => setActiveTab(tab.key)}
            className={cn(
              "h-8 rounded-lg px-3 items-center justify-center",
              activeTab === tab.key ? "bg-muted" : "hover:bg-muted/50",
            )}
          >
            <Text
              className={cn(
                "text-xs font-medium",
                activeTab === tab.key
                  ? "text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {t(tab.labelKey)}
            </Text>
          </Pressable>
        ))}
      </View>
      {/* Items */}
      {items.map((item) => (
        <View
          key={item.ticker}
          className="flex-row items-center justify-between py-1.5"
        >
          <View className="gap-0.5">
            <Text className="text-sm font-medium text-foreground">
              {item.ticker}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {item.name}
            </Text>
          </View>
          <View className="items-end gap-0.5">
            <Text className="text-sm font-medium text-foreground">
              ${item.price}
            </Text>
            <Text
              className={cn(
                "text-xs font-medium",
                item.positive ? "text-green-500" : "text-red-500",
              )}
            >
              {item.change}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/* ================================================================
   Sidebar: Equity Sectors Card
   ================================================================ */

function SectorsCard() {
  const { t } = useTranslation();

  return (
    <View className="rounded-xl border border-border bg-card p-4 gap-3">
      <Text className="text-sm font-semibold text-foreground">
        {t("finance.sectors")}
      </Text>
      {SECTORS.map((sector) => (
        <View
          key={sector.name}
          className="flex-row items-center justify-between py-1.5"
        >
          <Text className="text-sm font-medium text-foreground">
            {sector.name}
          </Text>
          <Text
            className={cn(
              "text-xs font-medium",
              sector.positive ? "text-green-500" : "text-red-500",
            )}
          >
            {sector.change}
          </Text>
        </View>
      ))}
    </View>
  );
}

/* ================================================================
   Finance Screen
   ================================================================ */

export default function FinanceScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useColorScheme();
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;
  const isDesktop = dimensions.width >= 1024;

  const [activeTab, setActiveTab] = useState<FinanceTab>("usMarkets");

  const handleBack = useCallback(() => router.back(), [router]);

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      {/* ── Header ── */}
      <View className="border-b border-border bg-background z-10">
        <View
          className="flex-row items-center justify-between px-4 h-14"
          style={{ maxWidth: 1080, alignSelf: "center", width: "100%" }}
        >
          {/* Left: Back + Title */}
          <View className="flex-row items-center gap-3">
            {!isLargeScreen && (
              <Pressable onPress={handleBack} className="p-1">
                <ArrowLeft size={20} color={colors.foreground} />
              </Pressable>
            )}
            <Text className="font-sans text-sm font-medium text-foreground">
              {t("finance.title")}
            </Text>
          </View>

          {/* Center: Tabs */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="flex-row items-center gap-1"
          >
            {FINANCE_TABS.map((tab) => (
              <Pressable
                key={tab.id}
                onPress={() => setActiveTab(tab.id)}
                className={cn(
                  "h-9 rounded-lg px-3 items-center justify-center",
                  activeTab === tab.id ? "bg-muted" : "hover:bg-muted/50",
                )}
              >
                <Text
                  className={cn(
                    "text-sm font-medium whitespace-nowrap",
                    activeTab === tab.id
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {tab.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          {/* Right: Share button */}
          <Pressable className="border border-border h-8 rounded-lg px-3 flex-row items-center justify-center hover:bg-muted">
            <Share2 size={14} color={colors.foreground} />
            {isLargeScreen && (
              <Text className="text-sm font-medium text-foreground ml-2">
                {t("discover.share")}
              </Text>
            )}
          </Pressable>
        </View>
      </View>

      {/* ── Content ── */}
      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-12"
        showsVerticalScrollIndicator={false}
      >
        <View
          className={cn(
            "w-full py-6 px-4",
            isDesktop ? "flex-row gap-6" : "flex-col gap-6",
          )}
          style={{
            maxWidth: 1080,
            alignSelf: "center",
            width: "100%",
          }}
        >
          {/* ── Main Content ── */}
          <View className="flex-1 gap-6">
            {/* Top Assets */}
            <View className="gap-3">
              <Text className="text-base font-semibold text-foreground">
                {t("finance.topAssets")}
              </Text>
              <View
                className={cn(
                  "gap-3",
                  isLargeScreen ? "flex-row flex-wrap" : "flex-row flex-wrap",
                )}
              >
                {TOP_ASSETS.map((asset) => (
                  <View
                    key={asset.name}
                    className="bg-card rounded-xl border border-border p-4"
                    style={
                      isLargeScreen
                        ? { width: "23.5%", minWidth: 160 }
                        : { width: "47.5%" }
                    }
                  >
                    <Text className="text-xs font-medium text-muted-foreground mb-1">
                      {asset.name}
                    </Text>
                    <Text className="text-lg font-semibold text-foreground">
                      {asset.value}
                    </Text>
                    <View className="flex-row items-center gap-1 mt-1">
                      {asset.positive ? (
                        <TrendingUp size={12} color="#22c55e" />
                      ) : (
                        <TrendingDown size={12} color="#ef4444" />
                      )}
                      <Text
                        className={cn(
                          "text-sm font-medium",
                          asset.positive ? "text-green-500" : "text-red-500",
                        )}
                      >
                        {asset.change}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            </View>

            {/* Market Summary */}
            <View className="gap-3">
              <Text className="text-base font-semibold text-foreground">
                {t("finance.marketSummary")}
              </Text>
              <View className="gap-2">
                {MARKET_HEADLINES.map((headline) => (
                  <AccordionItem key={headline.id} headline={headline} />
                ))}
              </View>
            </View>

            {/* Recent Developments */}
            <View className="gap-3">
              <Text className="text-base font-semibold text-foreground">
                {t("finance.recentDevelopments")}
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerClassName="gap-3"
              >
                {RECENT_NEWS.map((news) => (
                  <Pressable
                    key={news.id}
                    className="bg-card rounded-xl border border-border overflow-hidden"
                    style={{ width: 260 }}
                  >
                    {/* Image placeholder */}
                    <View className="h-[140px] bg-muted items-center justify-center">
                      <Text className="text-xs text-muted-foreground">
                        {news.imageUrl ? "Image" : "No image"}
                      </Text>
                    </View>
                    <View className="p-3 gap-2">
                      <Text
                        className="text-sm font-medium text-foreground leading-snug"
                        numberOfLines={2}
                      >
                        {news.title}
                      </Text>
                      <View className="flex-row items-center gap-2">
                        <Text className="text-xs text-muted-foreground">
                          {news.sourceCount} sources
                        </Text>
                        <Text className="text-xs text-muted-foreground">
                          {news.publishedAt}
                        </Text>
                      </View>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            </View>

            {/* Bottom Search Bar */}
            <View className="bg-card rounded-xl border border-border flex-row items-center gap-2 h-12 px-4">
              <Search size={16} color={colors.mutedForeground} />
              <TextInput
                placeholder={t("finance.searchPlaceholder")}
                placeholderTextColor={colors.mutedForeground}
                className="flex-1 min-w-0 bg-transparent text-foreground text-sm font-sans web:focus-visible:outline-none"
              />
            </View>
          </View>

          {/* ── Sidebar (desktop only) ── */}
          {isDesktop && (
            <View style={{ width: 336 }} className="gap-4 shrink-0">
              <WatchlistCard />
              <MoversCard />
              <SectorsCard />
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
