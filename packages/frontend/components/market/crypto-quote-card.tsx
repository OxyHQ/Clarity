/**
 * One cryptocurrency quote as a card — Finance's live row, and what Clarity's
 * agent shows for a `getMarketQuotes` result in the chat
 * (`components/chat/clarity-tool-renderers.tsx`). A pool-indexed price always
 * says where it came from and how old it is.
 */
import { View, type ViewStyle } from 'react-native';
import { TrendingDown, TrendingUp } from 'lucide-react-native';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useTranslation } from '@/hooks/useTranslation';
import type { MarketCardView } from '@/lib/market-format';
import { cn } from '@/lib/utils';

export function CryptoQuoteCard({
  view,
  label,
  isLargeScreen,
}: {
  view: MarketCardView;
  label: string;
  isLargeScreen: boolean;
}) {
  const { t } = useTranslation();
  const style: ViewStyle = isLargeScreen ? { width: '23.5%', minWidth: 160 } : { width: '47.5%' };

  if (view.state === 'loading') {
    return (
      <View className="bg-card rounded-xl border border-border p-4 gap-2" style={style}>
        <Text className="text-xs font-medium text-muted-foreground">{label}</Text>
        <Skeleton className="h-6 w-24 rounded-md" />
        <Skeleton className="h-3 w-16 rounded-md" />
      </View>
    );
  }

  if (view.state === 'error') {
    return (
      <View className="bg-card rounded-xl border border-border p-4 gap-1" style={style}>
        <Text className="text-xs font-medium text-muted-foreground">{label}</Text>
        <Text className="text-base font-semibold text-muted-foreground">
          {t('finance.crypto.unavailable')}
        </Text>
        <Text className="text-xs text-muted-foreground">{t('finance.crypto.unavailableBody')}</Text>
      </View>
    );
  }

  return (
    <View className="bg-card rounded-xl border border-border p-4 gap-1" style={style}>
      <Text className="text-xs font-medium text-muted-foreground">
        {view.name} · {view.symbol}
      </Text>
      {view.state === 'unpriced' ? (
        <>
          <Text className="text-base font-semibold text-muted-foreground">
            {t('finance.crypto.unpriced')}
          </Text>
          <Text className="text-xs text-muted-foreground">{t('finance.crypto.unpricedBody')}</Text>
        </>
      ) : (
        <>
          <Text className="text-lg font-semibold text-foreground">{view.price}</Text>
          {view.changePct ? (
            <View className="flex-row items-center gap-1">
              {view.direction === 'up' ? (
                <TrendingUp size={12} color="#22c55e" />
              ) : view.direction === 'down' ? (
                <TrendingDown size={12} color="#ef4444" />
              ) : null}
              <Text
                className={cn(
                  'text-sm font-medium',
                  view.direction === 'up'
                    ? 'text-green-500'
                    : view.direction === 'down'
                      ? 'text-red-500'
                      : 'text-muted-foreground',
                )}
              >
                {view.changePct}
              </Text>
            </View>
          ) : null}
        </>
      )}
      {/* A pool-indexed price has to say where it came from and how old it is. */}
      <Text className="text-[10px] text-muted-foreground mt-1" numberOfLines={2}>
        {t('finance.crypto.quotedBy', {
          source: view.source,
          updated: view.updatedAt,
        })}
      </Text>
    </View>
  );
}
