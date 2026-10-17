/**
 * One product as a card — the Shopping page's result row, and what Clarity's
 * agent shows for a `searchProducts` / `getProduct` result in the chat
 * (`components/chat/clarity-tool-renderers.tsx`).
 *
 * Mercaria answered it: the price is the lowest offer in that offer's own
 * currency, never converted, and an absent price or an absent set of offers is
 * said as such rather than filled in.
 */
import { Image } from 'expo-image';
import { Pressable, View } from 'react-native';
import { ShoppingBag, Store } from 'lucide-react-native';

import type { ProductDetail, ProductSource, ProductSummary } from '@clarity/shared-types';

import { Text } from '@/components/ui/text';
import { useTranslation } from '@/hooks/useTranslation';
import { detailPriceView, summaryPriceView } from '@/lib/products-format';
import { useColorScheme } from '@/lib/useColorScheme';
import { LinkButton } from '@oxy.so/bloom/button';

export function ProductCard({
  product,
  onPress,
}: {
  /** A search result, or a `getProduct` detail drawn as its card. */
  product: ProductSummary | ProductDetail;
  onPress: () => void;
}) {
  const { colors } = useColorScheme();
  const { t, locale } = useTranslation();
  const price =
    'variants' in product ? detailPriceView(product, locale) : summaryPriceView(product, locale);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="flex-row gap-3 rounded-xl border border-border/50 bg-card p-3 hover:bg-accent/30"
    >
      <View className="h-20 w-20 overflow-hidden rounded-lg bg-muted">
        {product.imageUrl ? (
          <Image
            source={{ uri: product.imageUrl }}
            style={{ width: '100%', height: '100%' }}
            contentFit="contain"
            transition={200}
            accessibilityLabel={product.name}
          />
        ) : (
          <View className="flex-1 items-center justify-center">
            <ShoppingBag size={24} color={colors.mutedForeground} />
          </View>
        )}
      </View>

      <View className="flex-1 gap-1">
        <Text className="text-base font-medium text-foreground" numberOfLines={2}>
          {product.name}
        </Text>
        {price.state === 'no_offers' ? (
          <Text className="text-sm text-muted-foreground">{t('shopping.noCurrentOffers')}</Text>
        ) : price.state === 'comparison_unavailable' ? (
          <Text className="text-sm text-muted-foreground">
            {t('shopping.offersUnavailableShort')}
          </Text>
        ) : (
          <>
            {price.state === 'mixed_currencies' ? null : (
              <Text className="text-base font-semibold text-foreground">
                {price.state === 'priced'
                  ? price.count > 1
                    ? t('shopping.fromPrice', { price: price.price })
                    : price.price
                  : t('shopping.noPrice')}
              </Text>
            )}
            <View className="flex-row items-center gap-1">
              <Store size={12} color={colors.mutedForeground} />
              <Text className="text-xs text-muted-foreground">
                {t('shopping.offerCount', { count: price.count })}
              </Text>
            </View>
          </>
        )}
      </View>
    </Pressable>
  );
}

/** "Results from Mercaria", linking the source that answered. Shown beside every answer. */
export function ProductAttribution({ source }: { source: ProductSource }) {
  const { t } = useTranslation();
  return (
    <View className="self-start">
      <LinkButton href={source.url} target="_blank" rel="noopener" size="sm" linkTone="secondary">
        {t('shopping.resultsFrom', { name: source.name })}
      </LinkButton>
    </View>
  );
}
