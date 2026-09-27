import { useState, useCallback, useMemo } from "react";
import {
  View,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Linking,
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
  Newspaper,
} from "lucide-react-native";
import type { NewsStory } from "@clarity/shared-types";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import { useNews } from "@/lib/hooks/use-news";
import { relativeTimeAgo } from "@/lib/relative-time";
import { newsLanguagesFor } from "@/lib/news-languages";

/* ================================================================
   Types
   ================================================================ */

interface Article {
  id: string;
  title: string;
  description?: string;
  imageUrl?: string;
  url: string;
  publisher?: string;
  faviconUrls: string[];
  sourceCount: number;
  /** Absent when the article states no publication date — then no time is shown. */
  publishedAt?: Date;
  rankingScore: number;
}

/** A story as a card: the lead article supplies the image, link and publisher. */
function toArticle(story: NewsStory): Article {
  const lead = story.articles.find((article) => article.imageUrl) ?? story.articles[0];
  const faviconUrls = [
    ...new Set(story.articles.flatMap((article) => (article.faviconUrl ? [article.faviconUrl] : []))),
  ];
  return {
    id: story.id,
    title: story.title,
    description: story.summary ?? lead?.description,
    imageUrl: lead?.imageUrl,
    url: lead?.canonicalUrl ?? "",
    publisher: lead?.publisher ?? (lead ? hostOf(lead.canonicalUrl) : undefined),
    faviconUrls,
    sourceCount: Math.max(story.sourceCount, story.articles.length),
    publishedAt: story.undated ? undefined : new Date(story.lastPublishedAt),
    rankingScore: story.rankingScore,
  };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/* ================================================================
   Sidebar data
   ================================================================ */

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

type Tab = "forYou" | "top";

/* ================================================================
   Source Favicons (stacked circles)
   ================================================================ */

function SourceIcons({ faviconUrls, count }: { faviconUrls: string[]; count: number }) {
  const { colors } = useColorScheme();
  const displayed = Math.min(Math.max(count, faviconUrls.length, 1), 3);
  const circleColors = [colors.primary, colors.muted, colors.surface];

  return (
    <View className="flex-row items-center">
      <View className="flex-row" style={{ width: displayed * 9 + 5 }}>
        {Array.from({ length: displayed }).map((_, i) => {
          const style = {
            width: 14,
            height: 14,
            borderRadius: 7,
            borderWidth: 1.5,
            borderColor: colors.card,
            marginLeft: i === 0 ? 0 : -5,
            zIndex: displayed - i,
            backgroundColor: circleColors[i % circleColors.length],
          };
          const favicon = faviconUrls[i];
          return favicon ? (
            <Image key={i} source={{ uri: favicon }} style={style} contentFit="cover" />
          ) : (
            <View key={i} style={style} />
          );
        })}
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
  const { t } = useTranslation();
  const open = useCallback(() => {
    if (article.url) void Linking.openURL(article.url);
  }, [article.url]);

  return (
    <Pressable
      onPress={open}
      accessibilityRole="link"
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
        {article.imageUrl ? (
          <Image
            source={{ uri: article.imageUrl }}
            style={{ width: "100%", height: "100%" }}
            contentFit="cover"
            transition={300}
          />
        ) : (
          <View className="flex-1 items-center justify-center">
            <Newspaper size={32} color={colors.mutedForeground} />
          </View>
        )}
        {/* Publisher badge */}
        {article.publisher ? (
          <View className="absolute top-2 left-2 rounded-md bg-background/80 px-2 py-0.5">
            <Text className="text-[10px] font-medium text-foreground" numberOfLines={1}>
              {article.publisher}
            </Text>
          </View>
        ) : null}
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
            <SourceIcons faviconUrls={article.faviconUrls} count={article.sourceCount} />
            <Text className="text-xs font-medium text-muted-foreground">
              {t("discover.sources", { count: article.sourceCount })}
            </Text>
            {article.publishedAt ? (
              <View className="flex-row items-center gap-1 ml-2">
                <Clock size={12} color={colors.mutedForeground} />
                <Text className="text-xs font-medium text-muted-foreground">
                  {relativeTimeAgo(article.publishedAt)}
                </Text>
              </View>
            ) : null}
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
  const { t, locale } = useTranslation();
  const router = useRouter();
  const { colors } = useColorScheme();
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;
  const isDesktop = dimensions.width >= 1024;

  const [activeTab, setActiveTab] = useState<Tab>("forYou");

  const handleBack = useCallback(() => router.back(), [router]);

  const languages = useMemo(() => newsLanguagesFor(locale), [locale]);
  const news = useNews(languages);
  const articles = useMemo(() => {
    const all = (news.data?.data ?? []).map(toArticle);
    // "For you" is newest first, as served; "Top" is the widest-covered stories.
    return activeTab === "top"
      ? [...all].sort((a, b) => b.sourceCount - a.sourceCount || b.rankingScore - a.rankingScore)
      : all;
  }, [news.data, activeTab]);
  const featuredArticle = articles[0];
  const regularArticles = articles.slice(1);

  const tabs: { key: Tab; label: string }[] = [
    { key: "forYou", label: t("discover.forYou") },
    { key: "top", label: t("discover.top") },
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
            {news.isPending ? (
              <View className="items-center justify-center py-16 gap-3">
                <ActivityIndicator color={colors.mutedForeground} />
                <Text className="text-sm text-muted-foreground">{t("discover.loading")}</Text>
              </View>
            ) : news.isError ? (
              <View className="items-center justify-center py-16 gap-3">
                <Text className="text-sm text-muted-foreground">{t("discover.error")}</Text>
                <Pressable
                  onPress={() => void news.refetch()}
                  className="border border-border h-8 rounded-lg px-3 items-center justify-center hover:bg-muted"
                >
                  <Text className="text-sm font-medium text-foreground">{t("discover.retry")}</Text>
                </Pressable>
              </View>
            ) : articles.length === 0 ? (
              <View className="items-center justify-center py-16 gap-3">
                <Newspaper size={28} color={colors.mutedForeground} />
                <Text className="text-sm text-muted-foreground">{t("discover.empty")}</Text>
              </View>
            ) : null}

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
