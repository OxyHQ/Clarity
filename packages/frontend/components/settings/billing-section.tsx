import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { CreditCard, Crown, ExternalLink, Sparkle } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { useTranslation } from '@/hooks/useTranslation';
import { bloomIcon } from '@/lib/bloom-icon';
import {
  useCancelSubscription,
  useCreatePortalSession,
  useSubscription,
  useSubscriptionPolling,
} from '@/lib/hooks/use-billing';

/** Where a person's Alia credits and usage are, which every chat turn spends. */
const ALIA_USAGE_URL = 'https://alia.onl/settings/usage';

interface BillingSectionProps {
  success?: boolean;
}

/**
 * Clarity's own billing: the plan, which unlocks Clarity's premium features
 * (deep research, higher power levels), and its payment methods. Chat itself is
 * paid with the person's Alia credits, which are Alia's to show and sell.
 */
export function BillingSection({ success }: BillingSectionProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const { data: subscription, isLoading, refetch } = useSubscription();
  const cancelSubscriptionMutation = useCancelSubscription();
  const createPortalMutation = useCreatePortalSession();
  const toastShown = useRef(false);

  const { data: polledSubscription } = useSubscriptionPolling(undefined, {
    enabled: !!success,
  });

  // Confirm the checkout once the webhook has made the subscription active.
  useEffect(() => {
    if (!success || toastShown.current) return;
    if (
      polledSubscription &&
      (polledSubscription.status === 'active' || polledSubscription.status === 'trialing')
    ) {
      toastShown.current = true;
      void refetch();
      toast.success(t('billing.paymentSuccess'));
      setTimeout(() => router.replace('/(app)/settings/billing'), 100);
    }
  }, [success, polledSubscription, refetch, router, t]);

  const handleCancelSubscription = async () => {
    if (!subscription) return;
    try {
      await cancelSubscriptionMutation.mutateAsync({ subscriptionId: subscription.id });
      toast.success(t('billing.cancelSubscriptionSuccess'));
    } catch (error: unknown) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t('billing.failedCancelSubscription'),
      );
    }
  };

  const handleManagePayment = async () => {
    try {
      const url = await createPortalMutation.mutateAsync(Linking.createURL('/settings/billing'));
      if (url) await Linking.openURL(url);
    } catch (error: unknown) {
      toast.error(
        error instanceof Error && error.message ? error.message : t('billing.failedPortal'),
      );
    }
  };

  if (isLoading) {
    return (
      <View className="py-6">
        <Text className="text-sm text-muted-foreground">{t('common.loading')}</Text>
      </View>
    );
  }

  const isSubscribed = subscription?.status === 'active';

  return (
    <View className="gap-3">
      {isSubscribed ? (
        <View className="border border-border rounded-xl p-3 gap-3">
          <View className="flex-row items-center gap-2">
            <Crown size={16} className="text-foreground" />
            <Text className="text-sm font-semibold text-foreground">
              {t('billing.activeSubscription')}
            </Text>
          </View>
          <View className="flex-row items-baseline justify-between">
            <Text className="text-sm text-muted-foreground">{subscription.plan.name}</Text>
            <Text className="text-base font-semibold text-primary">
              ${(subscription.plan.price / 100).toFixed(2)}
              {t('billing.perMonth')}
            </Text>
          </View>
          <Text className="text-xs text-muted-foreground">
            {subscription.cancelAtPeriodEnd
              ? t('billing.cancelsOn', {
                  date: new Date(subscription.currentPeriodEnd).toLocaleDateString(),
                })
              : t('billing.renewsOn', {
                  date: new Date(subscription.currentPeriodEnd).toLocaleDateString(),
                })}
          </Text>
          <View className="flex-row gap-2 pt-1 border-t border-border">
            <Button
              appearance="outline"
              tone="neutral"
              onPress={() => router.push('/(biglayout)/subscribe')}
              size="sm"
            >
              {t('billing.changePlan')}
            </Button>
            {!subscription.cancelAtPeriodEnd && (
              <Button
                appearance="outline"
                tone="neutral"
                onPress={handleCancelSubscription}
                disabled={cancelSubscriptionMutation.isPending}
                loading={cancelSubscriptionMutation.isPending}
                size="sm"
              >
                {t('billing.cancelSubscription')}
              </Button>
            )}
          </View>
        </View>
      ) : (
        <View className="border border-border rounded-xl p-3 gap-2">
          <View className="flex-row items-center gap-2">
            <Sparkle size={16} className="text-foreground" />
            <Text className="text-sm font-semibold text-foreground">{t('billing.freePlan')}</Text>
            <Button
              onPress={() => router.push('/(biglayout)/subscribe')}
              size="sm"
              className="ml-auto"
            >
              {t('billing.upgrade')}
            </Button>
          </View>
          <Text className="text-xs text-muted-foreground">{t('billing.freePlanDescription')}</Text>
        </View>
      )}

      <View className="border border-border rounded-xl p-3 gap-2">
        <Text className="text-sm font-semibold text-foreground">{t('billing.aliaCredits')}</Text>
        <Text className="text-xs text-muted-foreground">{t('billing.aliaCreditsDescription')}</Text>
        <Button
          appearance="outline"
          tone="neutral"
          size="sm"
          className="self-start"
          trailingIcon={bloomIcon(ExternalLink)}
          onPress={() => void Linking.openURL(ALIA_USAGE_URL)}
        >
          {t('billing.openAliaUsage')}
        </Button>
      </View>

      <View className="border border-border rounded-xl p-3">
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-semibold text-foreground">
            {t('billing.paymentMethods')}
          </Text>
          <Button
            appearance="outline"
            tone="neutral"
            onPress={handleManagePayment}
            disabled={createPortalMutation.isPending}
            loading={createPortalMutation.isPending}
            size="sm"
            leadingIcon={bloomIcon(CreditCard)}
            trailingIcon={bloomIcon(ExternalLink)}
          >
            {t('billing.managePaymentMethods')}
          </Button>
        </View>
      </View>
    </View>
  );
}
