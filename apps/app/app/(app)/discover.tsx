import { useState, useCallback } from "react";
import {
  View,
  ScrollView,
  Pressable,
  useWindowDimensions,
} from "react-native";
import { Text } from "@/components/ui/text";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ArrowLeft,
  Heart,
  MoreHorizontal,
  Clock,
  Share2,
  ChevronDown,
} from "lucide-react-native";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";

/* ================================================================
   Types
   ================================================================ */

interface Article {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
  sourceCount: number;
  publishedAt: string;
  category: string;
}

/* ================================================================
   Mock Data
   ================================================================ */

const MOCK_ARTICLES: Article[] = [
  {
    id: "1",
    title: "Major Breakthrough in Quantum Computing Achieves New Milestone for Error Correction",
    description:
      "Researchers have demonstrated a quantum processor that can correct its own errors in real time, a long-sought milestone that could accelerate the path to practical quantum computers capable of solving problems beyond classical reach.",
    imageUrl: "https://picsum.photos/seed/quantum/800/533",
    sourceCount: 12,
    publishedAt: "2h ago",
    category: "Technology",
  },
  {
    id: "2",
    title: "Global Climate Summit Reaches Historic Agreement on Carbon Markets",
    description:
      "World leaders have agreed on a unified framework for international carbon trading, establishing clear rules for cross-border emissions credits for the first time.",
    imageUrl: "https://picsum.photos/seed/climate/800/533",
    sourceCount: 18,
    publishedAt: "3h ago",
    category: "World",
  },
  {
    id: "3",
    title: "AI Models Now Outperform Doctors in Diagnosing Rare Diseases",
    description:
      "A new study shows that large language models trained on medical literature can identify rare conditions with higher accuracy than experienced specialists.",
    imageUrl: "https://picsum.photos/seed/aihealth/800/533",
    sourceCount: 9,
    publishedAt: "4h ago",
    category: "Science",
  },
  {
    id: "4",
    title: "SpaceX Successfully Tests Next-Generation Raptor Engine",
    description:
      "The upgraded engine delivers 30% more thrust while using less fuel, bringing the Starship program closer to its Mars ambitions.",
    imageUrl: "https://picsum.photos/seed/spacex/800/533",
    sourceCount: 7,
    publishedAt: "5h ago",
    category: "Technology",
  },
  {
    id: "5",
    title: "Federal Reserve Signals Shift in Monetary Policy Approach",
    description:
      "The central bank hinted at a new framework for managing inflation expectations, departing from its decades-old strategy.",
    imageUrl: "https://picsum.photos/seed/fedreserve/800/533",
    sourceCount: 15,
    publishedAt: "5h ago",
    category: "Business",
  },
  {
    id: "6",
    title: "Breakthrough Battery Technology Promises 1000-Mile Electric Vehicles",
    description:
      "A solid-state battery prototype achieves energy density three times higher than current lithium-ion cells.",
    imageUrl: "https://picsum.photos/seed/battery/800/533",
    sourceCount: 11,
    publishedAt: "6h ago",
    category: "Technology",
  },
  {
    id: "7",
    title: "New CRISPR Technique Eliminates Need for Viral Delivery Vectors",
    description:
      "Scientists have developed a lipid nanoparticle system that delivers gene-editing tools more safely and efficiently than viral methods.",
    imageUrl: "https://picsum.photos/seed/crispr/800/533",
    sourceCount: 6,
    publishedAt: "7h ago",
    category: "Science",
  },
  {
    id: "8",
    title: "European Tech Startups Raise Record Funding in First Quarter",
    description:
      "Venture capital investment in European technology companies surged to an all-time high, driven by AI and clean energy sectors.",
    imageUrl: "https://picsum.photos/seed/eutech/800/533",
    sourceCount: 8,
    publishedAt: "8h ago",
    category: "Business",
  },
  {
    id: "9",
    title: "New Study Reveals Ocean Currents Shifting Faster Than Models Predicted",
    description:
      "Satellite data shows major ocean circulation patterns are changing at an accelerated rate, with implications for weather and marine ecosystems.",
    imageUrl: "https://picsum.photos/seed/ocean/800/533",
    sourceCount: 10,
    publishedAt: "9h ago",
    category: "Science",
  },
  {
    id: "10",
    title: "Major Streaming Platforms Announce Joint Sports Broadcasting Deal",
    description:
      "Three leading services will share rights to premier league football, marking a shift away from traditional cable broadcasting.",
    imageUrl: "https://picsum.photos/seed/streaming/800/533",
    sourceCount: 5,
    publishedAt: "10h ago",
    category: "Entertainment",
  },
  {
    id: "11",
    title: "Autonomous Delivery Robots Begin Operating in 50 New US Cities",
    description:
      "Sidewalk delivery robots expand their reach as regulations catch up with the technology, now serving over 200 metropolitan areas.",
    imageUrl: "https://picsum.photos/seed/robots/800/533",
    sourceCount: 7,
    publishedAt: "11h ago",
    category: "Technology",
  },
  {
    id: "12",
    title: "Archaeological Discovery Rewrites Timeline of Ancient Mediterranean Trade",
    description:
      "Underwater excavations reveal trading networks existed centuries earlier than previously believed, reshaping our understanding of early civilizations.",
    imageUrl: "https://picsum.photos/seed/archaeology/800/533",
    sourceCount: 4,
    publishedAt: "12h ago",
    category: "Science",
  },
];

const TOPIC_CHIPS = [
  "Tech & Science",
  "Business",
  "Arts & Culture",
  "Sports",
  "Entertainment",
  "World News",
  "Health",
];

const MARKET_DATA = [
  { ticker: "S&P 500", value: "5,248.32", change: "+0.87%", positive: true },
  { ticker: "NASDAQ", value: "16,742.18", change: "+1.12%", positive: true },
  { ticker: "Bitcoin", value: "$68,432", change: "-1.24%", positive: false },
  { ticker: "VIX", value: "14.82", change: "-3.41%", positive: false },
];

const TRENDING_COMPANIES = [
  { name: "Nvidia", ticker: "NVDA", change: "+4.2%" },
  { name: "Apple", ticker: "AAPL", change: "+1.1%" },
  { name: "Tesla", ticker: "TSLA", change: "-2.3%" },
  { name: "Microsoft", ticker: "MSFT", change: "+0.8%" },
  { name: "Amazon", ticker: "AMZN", change: "+1.5%" },
];

type Tab = "forYou" | "top" | "topics";

/* ================================================================
   Source Favicons (stacked circles)
   ================================================================ */

function SourceIcons({ count }: { count: number }) {
  const { colors } = useColorScheme();
  const displayed = Math.min(count, 3);
  const circleColors = [colors.primary, colors.muted, colors.surface];

  return (
    <View className="flex-row items-center">
      <View className="flex-row" style={{ width: displayed * 9 + 5 }}>
        {Array.from({ length: displayed }).map((_, i) => (
          <View
            key={i}
            style={{
              width: 14,
              height: 14,
              borderRadius: 7,
              backgroundColor: circleColors[i % circleColors.length],
              borderWidth: 1.5,
              borderColor: colors.card,
              marginLeft: i === 0 ? 0 : -5,
              zIndex: displayed - i,
            }}
          />
        ))}
      </View>
    </View>
  );
}

/* ================================================================
   News Card
   ================================================================ */

function NewsCard({
  article,
  featured,
}: {
  article: Article;
  featured?: boolean;
}) {
  const { colors } = useColorScheme();

  return (
    <Pressable
      className={cn(
        "group",
        featured
          ? "flex-col md:flex-row md:gap-6"
          : "rounded-xl border border-border/50 bg-card overflow-hidden"
      )}
    >
      {/* Image */}
      <View
        className={cn(
          "relative overflow-hidden bg-muted",
          featured
            ? "aspect-[3/2] min-h-[200px] rounded-xl md:w-[43%]"
            : "aspect-[3/2]"
        )}
      >
        <Image
          source={{ uri: article.imageUrl }}
          style={{ width: "100%", height: "100%" }}
          contentFit="cover"
          transition={300}
        />
        {/* Category badge */}
        <View className="absolute top-2 left-2 rounded-md bg-background/80 px-2 py-0.5">
          <Text className="text-[10px] font-medium text-foreground">
            {article.category}
          </Text>
        </View>
      </View>

      {/* Content */}
      <View
        className={cn(
          "flex-1 justify-between",
          featured ? "gap-2 py-2" : "py-3 px-4 gap-2"
        )}
      >
        <Text
          className={cn(
            "text-foreground font-medium leading-snug",
            featured ? "text-xl md:text-2xl" : "text-sm"
          )}
          numberOfLines={3}
        >
          {article.title}
        </Text>

        {featured && article.description ? (
          <Text
            className="text-sm text-muted-foreground leading-relaxed"
            numberOfLines={6}
          >
            {article.description}
          </Text>
        ) : null}

        {/* Footer */}
        <View className="flex-row items-center justify-between mt-auto pt-1">
          <View className="flex-row items-center gap-2">
            <SourceIcons count={article.sourceCount} />
            <Text className="text-xs font-medium text-muted-foreground">
              {article.sourceCount} sources
            </Text>
            <View className="flex-row items-center gap-1 ml-2">
              <Clock size={12} color={colors.mutedForeground} />
              <Text className="text-xs font-medium text-muted-foreground">
                {article.publishedAt}
              </Text>
            </View>
          </View>
          <View className="flex-row items-center">
            <Pressable className="h-8 w-8 rounded-full items-center justify-center hover:bg-accent">
              <Heart size={16} color={colors.mutedForeground} />
            </Pressable>
            <Pressable className="h-8 w-8 rounded-full items-center justify-center hover:bg-accent">
              <MoreHorizontal size={16} color={colors.mutedForeground} />
            </Pressable>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

/* ================================================================
   Sidebar: Make It Yours
   ================================================================ */

function MakeItYoursCard() {
  const { t } = useTranslation();

  return (
    <View className="rounded-xl border border-border/50 bg-card p-4 gap-3">
      <Text className="text-sm font-semibold text-foreground">
        {t("discover.makeItYours")}
      </Text>
      <Text className="text-xs text-muted-foreground">
        {t("discover.selectTopics")}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {TOPIC_CHIPS.map((chip) => (
          <Pressable
            key={chip}
            className="h-8 rounded-md border border-border/50 bg-muted px-3 items-center justify-center hover:bg-accent"
          >
            <Text className="text-xs font-medium text-foreground">{chip}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable className="h-10 rounded-lg bg-primary items-center justify-center mt-1">
        <Text className="text-sm font-medium text-primary-foreground">
          {t("discover.saveInterests")}
        </Text>
      </Pressable>
    </View>
  );
}

/* ================================================================
   Sidebar: Market Outlook
   ================================================================ */

function MarketOutlookCard() {
  const { t } = useTranslation();

  return (
    <View className="rounded-xl border border-border/50 bg-card p-4 gap-3">
      <Text className="text-sm font-semibold text-foreground">
        {t("discover.marketOutlook")}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {MARKET_DATA.map((item) => (
          <View
            key={item.ticker}
            className="flex-1 min-w-[45%] rounded-lg border border-border/50 bg-muted/50 p-3 gap-1"
          >
            <Text className="text-[10px] font-medium text-muted-foreground">
              {item.ticker}
            </Text>
            <Text className="text-sm font-semibold text-foreground">
              {item.value}
            </Text>
            <Text
              className={cn(
                "text-xs font-medium",
                item.positive ? "text-green-500" : "text-red-500"
              )}
            >
              {item.change}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/* ================================================================
   Sidebar: Trending Companies
   ================================================================ */

function TrendingCompaniesCard() {
  const { t } = useTranslation();

  return (
    <View className="rounded-xl border border-border/50 bg-card p-4 gap-3">
      <Text className="text-sm font-semibold text-foreground">
        {t("discover.trendingCompanies")}
      </Text>
      {TRENDING_COMPANIES.map((company) => (
        <View
          key={company.ticker}
          className="flex-row items-center justify-between py-1.5"
        >
          <View className="flex-row items-center gap-2">
            <Text className="text-sm font-medium text-foreground">
              {company.name}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {company.ticker}
            </Text>
          </View>
          <Text
            className={cn(
              "text-xs font-medium",
              company.change.startsWith("+")
                ? "text-green-500"
                : "text-red-500"
            )}
          >
            {company.change}
          </Text>
        </View>
      ))}
    </View>
  );
}

/* ================================================================
   Discover Screen
   ================================================================ */

export default function DiscoverScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useColorScheme();
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;
  const isDesktop = dimensions.width >= 1024;

  const [activeTab, setActiveTab] = useState<Tab>("forYou");

  const handleBack = useCallback(() => router.back(), [router]);

  const featuredArticle = MOCK_ARTICLES[0];
  const regularArticles = MOCK_ARTICLES.slice(1);

  const tabs: { key: Tab; label: string; hasDropdown?: boolean }[] = [
    { key: "forYou", label: t("discover.forYou") },
    { key: "top", label: t("discover.top") },
    { key: "topics", label: t("discover.topics"), hasDropdown: true },
  ];

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      {/* ── Header (sticky) ── */}
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
              {t("discover.title")}
            </Text>
          </View>

          {/* Center: Tabs */}
          <View className="flex-row items-center gap-1">
            {tabs.map((tab) => (
              <Pressable
                key={tab.key}
                onPress={() => setActiveTab(tab.key)}
                className={cn(
                  "h-9 rounded-lg px-3 flex-row items-center justify-center",
                  activeTab === tab.key
                    ? "bg-muted"
                    : "hover:bg-muted/50"
                )}
              >
                <Text
                  className={cn(
                    "text-sm font-medium",
                    activeTab === tab.key
                      ? "text-foreground"
                      : "text-muted-foreground"
                  )}
                >
                  {tab.label}
                </Text>
                {tab.hasDropdown && (
                  <ChevronDown
                    size={14}
                    color={
                      activeTab === tab.key
                        ? colors.foreground
                        : colors.mutedForeground
                    }
                    style={{ marginLeft: 2 }}
                  />
                )}
              </Pressable>
            ))}
          </View>

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
            isDesktop ? "flex-row gap-6" : "flex-col gap-6"
          )}
          style={{
            maxWidth: 1080,
            alignSelf: "center",
            width: "100%",
          }}
        >
          {/* ── Main Content ── */}
          <View className="flex-1 gap-6">
            {/* Featured Card */}
            {featuredArticle && (
              <NewsCard article={featuredArticle} featured />
            )}

            {/* Card Grid */}
            <View
              className={cn(
                "gap-4",
                isDesktop
                  ? "flex-row flex-wrap"
                  : isLargeScreen
                    ? "flex-row flex-wrap"
                    : "flex-col"
              )}
            >
              {regularArticles.map((article) => (
                <View
                  key={article.id}
                  style={
                    isDesktop
                      ? { width: "31.5%" }
                      : isLargeScreen
                        ? { width: "48%" }
                        : { width: "100%" }
                  }
                >
                  <NewsCard article={article} />
                </View>
              ))}
            </View>
          </View>

          {/* ── Sidebar (desktop only) ── */}
          {isDesktop && (
            <View style={{ width: 336 }} className="gap-4 shrink-0">
              <MakeItYoursCard />
              <MarketOutlookCard />
              <TrendingCompaniesCard />
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
