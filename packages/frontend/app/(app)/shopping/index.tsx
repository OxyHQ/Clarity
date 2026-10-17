import { useCallback, useMemo, useState } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Search } from 'lucide-react-native';

import { ProductAttribution, ProductCard } from '@/components/shopping/product-card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useProductSearch } from '@/lib/hooks/use-products';
import { productErrorKind } from '@/lib/products-format';
import { useColorScheme } from '@/lib/useColorScheme';
import { useTranslation } from '@/hooks/useTranslation';
import { cn } from '@/lib/utils';
import { bloomIcon } from '@/lib/bloom-icon';
import { Button, GlyphButton } from '@oxy.so/bloom/button';

/** The backend accepts a query of 1–200 characters. */
const MAX_QUERY_LENGTH = 200;

export default function ShoppingScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useColorScheme();
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;

  const [queryDraft, setQueryDraft] = useState('');
  const [query, setQuery] = useState('');

  const search = useProductSearch(query);
  // Mercaria's order, page after page — never re-sorted here.
  const products = useMemo(
    () => (search.data?.pages ?? []).flatMap((page) => page.results),
    [search.data],
  );
  const source = search.data?.pages[0]?.source;

  const submit = useCallback(() => {
    setQuery(queryDraft.trim().slice(0, MAX_QUERY_LENGTH));
  }, [queryDraft]);

  const openProduct = useCallback(
    (id: string) => router.push({ pathname: '/(app)/shopping/[id]', params: { id } }),
    [router],
  );

  // A failed "load more" keeps the pages already shown; only a failed first page replaces them.
  const errorKind =
    search.isError && !search.isFetchNextPageError ? productErrorKind(search.error) : undefined;

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="border-b border-border bg-background z-10">
        <View
          className="flex-row items-center gap-3 px-4 h-14"
          style={{ maxWidth: 1080, alignSelf: 'center', width: '100%' }}
        >
          {!isLargeScreen && (
            <GlyphButton
              icon={bloomIcon(ArrowLeft)}
              accessibilityLabel={t('common.back')}
              onPress={() => router.back()}
            />
          )}
          <Text className="font-sans text-sm font-medium text-foreground">
            {t('shopping.title')}
          </Text>
        </View>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-12"
        showsVerticalScrollIndicator={false}
      >
        <View
          className="w-full px-4 py-6 gap-5"
          style={{ maxWidth: 1080, alignSelf: 'center', width: '100%' }}
        >
          <View className="gap-1">
            <Text className="text-2xl font-semibold text-foreground">{t('shopping.heading')}</Text>
            <Text className="text-sm text-muted-foreground">{t('shopping.subheading')}</Text>
          </View>

          {/* ── Query ── */}
          <View className={cn('gap-2', isLargeScreen && 'flex-row')}>
            <View className={cn('flex-row items-center gap-2', isLargeScreen && 'flex-1')}>
              <Search size={16} color={colors.mutedForeground} />
              <Input
                className="flex-1"
                value={queryDraft}
                onChangeText={setQueryDraft}
                onSubmitEditing={submit}
                returnKeyType="search"
                maxLength={MAX_QUERY_LENGTH}
                placeholder={t('shopping.queryPlaceholder')}
                accessibilityLabel={t('shopping.queryPlaceholder')}
              />
            </View>
            <Button onPress={submit}>{t('shopping.searchAction')}</Button>
          </View>

          {/* ── States ── */}
          {!query ? (
            <View className="rounded-xl border border-border/60 bg-card p-6 gap-2">
              <Text className="text-sm font-medium text-foreground">
                {t('shopping.promptTitle')}
              </Text>
              <Text className="text-sm text-muted-foreground">{t('shopping.promptBody')}</Text>
            </View>
          ) : search.isPending ? (
            <View className="gap-3">
              {[0, 1, 2, 3].map((item) => (
                <Skeleton key={item} className="h-24 w-full rounded-xl" />
              ))}
            </View>
          ) : errorKind ? (
            <View className="rounded-xl border border-border/60 bg-card p-6 gap-3 items-start">
              <Text className="text-sm font-medium text-foreground">
                {t('shopping.errorTitle')}
              </Text>
              <Text className="text-sm text-muted-foreground">
                {t(`shopping.searchError.${errorKind}`)}
              </Text>
              <Button appearance="outline" tone="neutral" onPress={() => search.refetch()}>
                {t('shopping.retry')}
              </Button>
            </View>
          ) : products.length === 0 ? (
            <View className="rounded-xl border border-border/60 bg-card p-6 gap-2">
              <Text className="text-sm font-medium text-foreground">
                {t('shopping.emptyTitle')}
              </Text>
              <Text className="text-sm text-muted-foreground">{t('shopping.emptyBody')}</Text>
              {source ? <ProductAttribution source={source} /> : null}
            </View>
          ) : (
            <View className="gap-3">
              {source ? <ProductAttribution source={source} /> : null}
              {products.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  onPress={() => openProduct(product.id)}
                />
              ))}
              {search.hasNextPage ? (
                <Button
                  appearance="outline"
                  tone="neutral"
                  onPress={() => search.fetchNextPage()}
                  disabled={search.isFetchingNextPage}
                >
                  {search.isFetchingNextPage ? t('shopping.loadingMore') : t('shopping.loadMore')}
                </Button>
              ) : null}
              {search.isFetchNextPageError ? (
                <Text className="text-xs text-muted-foreground">{t('shopping.loadMoreError')}</Text>
              ) : null}
            </View>
          )}

          <Text className="text-xs text-muted-foreground">{t('shopping.disclaimer')}</Text>
        </View>
      </ScrollView>
    </View>
  );
}
