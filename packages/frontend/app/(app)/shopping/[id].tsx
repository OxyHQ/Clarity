import { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { ArrowLeft, CalendarClock, ExternalLink, ShoppingBag, Store } from 'lucide-react-native';

import type { ProductDetail, ProductOffer } from '@clarity/shared-types';

import { ProductAttribution } from '@/components/shopping/product-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useProduct } from '@/lib/hooks/use-products';
import {
  availabilityKey,
  conditionLabel,
  formatObservedAt,
  formatProductMoney,
  offerAction,
  productErrorKind,
  sellerView,
} from '@/lib/products-format';
import { useColorScheme } from '@/lib/useColorScheme';
import { useTranslation } from '@/hooks/useTranslation';
import { bloomIcon } from '@/lib/bloom-icon';
import { Button, GlyphButton, LinkButton } from '@oxy.so/bloom/button';

function OfferRow({
  offer,
  variantName,
  now,
}: {
  offer: ProductOffer;
  variantName: string | null;
  now: Date;
}) {
  const { t, locale } = useTranslation();
  const { colors } = useColorScheme();
  const seller = sellerView(offer.seller);
  const price = offer.price ? formatProductMoney(offer.price, locale) : null;
  const seen = formatObservedAt(offer.observedAt, locale, now);
  const condition = conditionLabel(offer.condition);
  const action = offerAction(offer);

  return (
    <View className="rounded-xl border border-border/50 bg-card p-4 gap-2">
      <View className="flex-row flex-wrap items-start justify-between gap-2">
        <View className="flex-1 gap-0.5">
          <View className="flex-row items-center gap-1.5">
            <Store size={13} color={colors.mutedForeground} />
            <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
              {seller.name ?? t('shopping.unknownSeller')}
            </Text>
          </View>
          {seller.domain ? (
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {seller.domain}
            </Text>
          ) : null}
        </View>
        <Text className="text-base font-semibold text-foreground">
          {price ?? t('shopping.priceNotStated')}
        </Text>
      </View>

      <View className="flex-row flex-wrap gap-1.5">
        <View className="rounded-md bg-muted px-2 py-0.5">
          <Text className="text-[11px] font-medium text-muted-foreground">
            {t(availabilityKey(offer.availability))}
          </Text>
        </View>
        {condition ? (
          <View className="rounded-md bg-muted px-2 py-0.5">
            <Text className="text-[11px] font-medium text-muted-foreground">
              {'i18nKey' in condition ? t(condition.i18nKey) : condition.raw}
            </Text>
          </View>
        ) : null}
        {variantName ? (
          <View className="rounded-md border border-border/60 px-2 py-0.5">
            <Text className="text-[11px] text-muted-foreground">{variantName}</Text>
          </View>
        ) : null}
      </View>

      {seen ? (
        <View className="flex-row items-center gap-1">
          <CalendarClock size={12} color={colors.mutedForeground} />
          <Text className="text-xs text-muted-foreground">
            {t('shopping.seen', { when: seen })}
          </Text>
        </View>
      ) : null}

      {action.kind === 'native' ? (
        <View className="self-start">
          <Button href={action.href} target="_blank" leadingIcon={bloomIcon(ShoppingBag)}>
            {t('shopping.buyOnMercaria')}
          </Button>
        </View>
      ) : action.kind === 'external' ? (
        <View className="self-start">
          <Button
            href={action.href}
            target="_blank"
            rel={action.rel}
            appearance="outline"
            tone="neutral"
            leadingIcon={bloomIcon(ExternalLink)}
          >
            {action.host ? t('shopping.viewOn', { host: action.host }) : t('shopping.viewOffer')}
          </Button>
        </View>
      ) : null}

      {/* The licence an open-data source requires, shown whenever it is present. */}
      {offer.attribution ? (
        <View className="self-start">
          <LinkButton
            href={offer.attribution.homepage}
            target="_blank"
            rel="noopener"
            size="sm"
            linkTone="secondary"
          >
            {`${offer.attribution.name} · ${offer.attribution.licence}`}
          </LinkButton>
        </View>
      ) : null}
    </View>
  );
}

function Offers({ product }: { product: ProductDetail }) {
  const { t } = useTranslation();
  // Offers age against the moment the page was drawn.
  const now = useMemo(() => new Date(), []);
  const variantNames = useMemo(
    () => new Map(product.variants.map((variant) => [variant.id, variant.name])),
    [product.variants],
  );
  const showVariant = product.variants.length > 1;

  // `null` means Mercaria is not serving price comparison right now — never "nobody sells it".
  if (product.offers === null) {
    return (
      <View className="rounded-xl border border-border/60 bg-muted/40 p-3">
        <Text className="text-xs text-muted-foreground">{t('shopping.offersUnavailable')}</Text>
      </View>
    );
  }
  if (product.offers.length === 0) {
    return <Text className="text-sm text-muted-foreground">{t('shopping.noCurrentOffers')}</Text>;
  }
  return (
    // Mercaria's ranked order, exactly as given.
    <View className="gap-3">
      {product.offers.map((offer) => (
        <OfferRow
          key={offer.id}
          offer={offer}
          variantName={showVariant ? (variantNames.get(offer.variantId) ?? null) : null}
          now={now}
        />
      ))}
    </View>
  );
}

export default function ProductDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useColorScheme();
  const insets = useSafeAreaInsets();
  const query = useProduct(typeof id === 'string' ? id : undefined);
  const product = query.data;
  const errorKind = query.isError ? productErrorKind(query.error) : undefined;

  const images = product
    ? product.images.length > 0
      ? product.images
      : product.imageUrl
        ? [product.imageUrl]
        : []
    : [];

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="border-b border-border bg-background z-10">
        <View
          className="flex-row items-center gap-3 px-4 h-14"
          style={{ maxWidth: 860, alignSelf: 'center', width: '100%' }}
        >
          <GlyphButton
            icon={bloomIcon(ArrowLeft)}
            accessibilityLabel={t('common.back')}
            onPress={() => router.back()}
          />
          <Text className="font-sans text-sm font-medium text-foreground">
            {t('shopping.title')}
          </Text>
        </View>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-16"
        showsVerticalScrollIndicator={false}
      >
        <View
          className="w-full px-4 py-6 gap-5"
          style={{ maxWidth: 860, alignSelf: 'center', width: '100%' }}
        >
          {query.isPending ? (
            <View className="gap-3">
              <Skeleton className="h-56 w-full rounded-xl" />
              <Skeleton className="h-8 w-3/4 rounded-lg" />
              <Skeleton className="h-24 w-full rounded-xl" />
            </View>
          ) : errorKind || !product ? (
            <View className="rounded-xl border border-border/60 bg-card p-6 gap-3 items-start">
              <Text className="text-sm font-medium text-foreground">
                {t(`shopping.detailError.${errorKind ?? 'other'}.title`)}
              </Text>
              <Text className="text-sm text-muted-foreground">
                {t(`shopping.detailError.${errorKind ?? 'other'}.body`)}
              </Text>
              {errorKind === 'gone' || errorKind === 'not_found' ? (
                <Button
                  appearance="outline"
                  tone="neutral"
                  onPress={() => router.replace('/(app)/shopping')}
                >
                  {t('shopping.backToSearch')}
                </Button>
              ) : (
                <Button appearance="outline" tone="neutral" onPress={() => query.refetch()}>
                  {t('shopping.retry')}
                </Button>
              )}
            </View>
          ) : (
            <>
              {images.length > 0 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerClassName="gap-3"
                >
                  {images.map((uri, index) => (
                    <View
                      key={uri}
                      className="h-56 w-56 overflow-hidden rounded-xl border border-border/40 bg-muted"
                    >
                      <Image
                        source={{ uri }}
                        style={{ width: '100%', height: '100%' }}
                        contentFit="contain"
                        transition={200}
                        accessibilityLabel={
                          index === 0
                            ? product.name
                            : t('shopping.imageLabel', { name: product.name, index: index + 1 })
                        }
                      />
                    </View>
                  ))}
                </ScrollView>
              ) : (
                <View className="h-40 w-full items-center justify-center rounded-xl bg-muted">
                  <ShoppingBag size={32} color={colors.mutedForeground} />
                </View>
              )}

              <View className="gap-2">
                <Text className="text-2xl font-semibold text-foreground">{product.name}</Text>
                <ProductAttribution source={product.source} />
              </View>

              {product.description ? (
                <View className="gap-2">
                  <Text className="text-sm font-medium text-foreground">
                    {t('shopping.descriptionHeading')}
                  </Text>
                  {/* Plain text from Mercaria: rendered as text, never as markup. */}
                  <Text className="text-sm text-muted-foreground leading-relaxed" selectable>
                    {product.description}
                  </Text>
                </View>
              ) : null}

              {product.variants.length > 1 || product.variants.some((variant) => variant.name) ? (
                <View className="gap-2">
                  <Text className="text-sm font-medium text-foreground">
                    {t('shopping.variantsHeading')}
                  </Text>
                  <View className="flex-row flex-wrap gap-1.5">
                    {product.variants.map((variant) => (
                      <View
                        key={variant.id}
                        className="rounded-md border border-border/60 px-2 py-1"
                      >
                        <Text className="text-[11px] text-muted-foreground">
                          {variant.name ?? t('shopping.unnamedVariant')}
                        </Text>
                      </View>
                    ))}
                  </View>
                </View>
              ) : null}

              <View className="gap-2">
                <Text className="text-sm font-medium text-foreground">
                  {t('shopping.offersHeading')}
                </Text>
                <Offers product={product} />
              </View>

              <Text className="text-xs text-muted-foreground">{t('shopping.disclaimer')}</Text>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
