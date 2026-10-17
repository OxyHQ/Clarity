import { useState, useCallback, useMemo } from 'react';
import { View, ScrollView, ActivityIndicator, useWindowDimensions } from 'react-native';
import { Text } from '@/components/ui/text';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Share2, Newspaper } from 'lucide-react-native';
import { NewsCard, toArticle } from '@/components/news/news-card';
import { useColorScheme } from '@/lib/useColorScheme';
import { useTranslation } from '@/hooks/useTranslation';
import { cn } from '@/lib/utils';
import { useNews } from '@/lib/hooks/use-news';
import { newsLanguagesFor } from '@/lib/news-languages';
import { bloomIcon } from '@/lib/bloom-icon';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { Button, GlyphButton } from '@oxy.so/bloom/button';
import { Chip } from '@oxy.so/bloom/chip';

/* ================================================================
   Sidebar data
   ================================================================ */

const TOPIC_CHIPS = [
  'Tech & Science',
  'Business',
  'Arts & Culture',
  'Sports',
  'Entertainment',
  'World News',
  'Health',
];

const MARKET_DATA = [
  { ticker: 'S&P 500', value: '5,248.32', change: '+0.87%', positive: true },
  { ticker: 'NASDAQ', value: '16,742.18', change: '+1.12%', positive: true },
  { ticker: 'Bitcoin', value: '$68,432', change: '-1.24%', positive: false },
  { ticker: 'VIX', value: '14.82', change: '-3.41%', positive: false },
];

const TRENDING_COMPANIES = [
  { name: 'Nvidia', ticker: 'NVDA', change: '+4.2%' },
  { name: 'Apple', ticker: 'AAPL', change: '+1.1%' },
  { name: 'Tesla', ticker: 'TSLA', change: '-2.3%' },
  { name: 'Microsoft', ticker: 'MSFT', change: '+0.8%' },
  { name: 'Amazon', ticker: 'AMZN', change: '+1.5%' },
];

type Tab = 'forYou' | 'top';

/* ================================================================
   Sidebar: Make It Yours
   ================================================================ */

function MakeItYoursCard() {
  const { t } = useTranslation();

  return (
    <View className="rounded-xl border border-border/50 bg-card p-4 gap-3">
      <Text className="text-sm font-semibold text-foreground">{t('discover.makeItYours')}</Text>
      <Text className="text-xs text-muted-foreground">{t('discover.selectTopics')}</Text>
      <View className="flex-row flex-wrap gap-2">
        {TOPIC_CHIPS.map((chip) => (
          <Chip key={chip} size="xl">
            {chip}
          </Chip>
        ))}
      </View>
      <Button className="mt-1">{t('discover.saveInterests')}</Button>
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
      <Text className="text-sm font-semibold text-foreground">{t('discover.marketOutlook')}</Text>
      <View className="flex-row flex-wrap gap-2">
        {MARKET_DATA.map((item) => (
          <View
            key={item.ticker}
            className="flex-1 min-w-[45%] rounded-lg border border-border/50 bg-muted/50 p-3 gap-1"
          >
            <Text className="text-[10px] font-medium text-muted-foreground">{item.ticker}</Text>
            <Text className="text-sm font-semibold text-foreground">{item.value}</Text>
            <Text
              className={cn(
                'text-xs font-medium',
                item.positive ? 'text-green-500' : 'text-red-500',
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
        {t('discover.trendingCompanies')}
      </Text>
      {TRENDING_COMPANIES.map((company) => (
        <View key={company.ticker} className="flex-row items-center justify-between py-1.5">
          <View className="flex-row items-center gap-2">
            <Text className="text-sm font-medium text-foreground">{company.name}</Text>
            <Text className="text-xs text-muted-foreground">{company.ticker}</Text>
          </View>
          <Text
            className={cn(
              'text-xs font-medium',
              company.change.startsWith('+') ? 'text-green-500' : 'text-red-500',
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

  const [activeTab, setActiveTab] = useState<Tab>('forYou');

  const handleBack = useCallback(() => router.back(), [router]);

  const languages = useMemo(() => newsLanguagesFor(locale), [locale]);
  const news = useNews(languages);
  const articles = useMemo(() => {
    const all = (news.data?.data ?? []).map(toArticle);
    // "For you" is newest first, as served; "Top" is the widest-covered stories.
    return activeTab === 'top'
      ? [...all].sort((a, b) => b.sourceCount - a.sourceCount || b.rankingScore - a.rankingScore)
      : all;
  }, [news.data, activeTab]);
  const featuredArticle = articles[0];
  const regularArticles = articles.slice(1);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'forYou', label: t('discover.forYou') },
    { key: 'top', label: t('discover.top') },
  ];

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      {/* ── Header (sticky) ── */}
      <View className="border-b border-border bg-background z-10">
        <View
          className="flex-row items-center justify-between px-4 h-14"
          style={{ maxWidth: 1080, alignSelf: 'center', width: '100%' }}
        >
          {/* Left: Back + Title */}
          <View className="flex-row items-center gap-3">
            {!isLargeScreen && (
              <GlyphButton
                icon={bloomIcon(ArrowLeft)}
                accessibilityLabel={t('common.back')}
                onPress={handleBack}
              />
            )}
            <Text className="font-sans text-sm font-medium text-foreground">
              {t('discover.title')}
            </Text>
          </View>

          {/* Center: Tabs */}
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as Tab)}
            variant="pill"
            label={t('discover.title')}
          >
            {tabs.map((tab) => (
              <TabsTrigger key={tab.key} value={tab.key} label={tab.label} />
            ))}
          </Tabs>

          {/* Right: Share button */}
          <Button
            appearance="outline"
            tone="neutral"
            size="sm"
            leadingIcon={bloomIcon(Share2)}
            iconOnly={!isLargeScreen}
            accessibilityLabel={t('discover.share')}
          >
            {t('discover.share')}
          </Button>
        </View>
      </View>

      {/* ── Content ── */}
      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-12"
        showsVerticalScrollIndicator={false}
      >
        <View
          className={cn('w-full py-6 px-4', isDesktop ? 'flex-row gap-6' : 'flex-col gap-6')}
          style={{
            maxWidth: 1080,
            alignSelf: 'center',
            width: '100%',
          }}
        >
          {/* ── Main Content ── */}
          <View className="flex-1 gap-6">
            {news.isPending ? (
              <View className="items-center justify-center py-16 gap-3">
                <ActivityIndicator color={colors.mutedForeground} />
                <Text className="text-sm text-muted-foreground">{t('discover.loading')}</Text>
              </View>
            ) : news.isError ? (
              <View className="items-center justify-center py-16 gap-3">
                <Text className="text-sm text-muted-foreground">{t('discover.error')}</Text>
                <Button
                  appearance="outline"
                  tone="neutral"
                  size="sm"
                  onPress={() => void news.refetch()}
                >
                  {t('discover.retry')}
                </Button>
              </View>
            ) : articles.length === 0 ? (
              <View className="items-center justify-center py-16 gap-3">
                <Newspaper size={28} color={colors.mutedForeground} />
                <Text className="text-sm text-muted-foreground">{t('discover.empty')}</Text>
              </View>
            ) : null}

            {/* Featured Card */}
            {featuredArticle && <NewsCard article={featuredArticle} featured />}

            {/* Card Grid */}
            <View
              className={cn(
                'gap-4',
                isDesktop
                  ? 'flex-row flex-wrap'
                  : isLargeScreen
                    ? 'flex-row flex-wrap'
                    : 'flex-col',
              )}
            >
              {regularArticles.map((article) => (
                <View
                  key={article.id}
                  style={
                    isDesktop
                      ? { width: '31.5%' }
                      : isLargeScreen
                        ? { width: '48%' }
                        : { width: '100%' }
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
