import type { ReactNode } from 'react';
import { Slot, usePathname, useRouter } from 'expo-router';
import { useOxy, useSupervision } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AppErrorBoundary } from '@/components/error-boundary';
import { claritySurfaceAccess } from '@/lib/supervised-surfaces';
import { useTranslation } from '@/hooks/useTranslation';

/** Remount on account/session transitions so prior product data cannot render. */
export function SupervisedSurfaceGate({
  children,
  experience = false,
}: {
  children: ReactNode;
  experience?: boolean;
}) {
  const { user, isAuthenticated, activeSessionId } = useOxy();
  return (
    <CurrentSessionGate
      key={`${user?.id ?? 'anonymous'}:${activeSessionId ?? 'none'}:${isAuthenticated}`}
      experience={experience}
    >
      {children}
    </CurrentSessionGate>
  );
}

function CurrentSessionGate({
  children,
  experience,
}: {
  children: ReactNode;
  experience: boolean;
}) {
  const { user, isAuthenticated, isAuthResolved, activeSessionId, showBottomSheet } = useOxy();
  const supervision = useSupervision();
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const access = claritySurfaceAccess({
    isAuthenticated,
    isAuthResolved,
    activeSessionId,
    accountId: user?.id,
    kind: user?.kind,
    state: supervision.data,
  });
  if (access === 'ordinary') return children;
  return (
    <AppErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {access === 'limited' && experience && pathname === '/settings/experience' ? (
          <Slot />
        ) : (
          <View className="flex-1 items-center justify-center bg-background p-6">
            <View className="w-full max-w-md gap-4">
              <Text className="text-foreground text-xl font-semibold">
                {t('supervisedAccess.title')}
              </Text>
              {access === 'pending' ? (
                supervision.isError ? (
                  <>
                    <Text accessibilityRole="alert" className="text-muted-foreground">
                      {t('supervisedAccess.error')}
                    </Text>
                    <Button onPress={() => void supervision.refetch()}>{t('common.retry')}</Button>
                  </>
                ) : (
                  <Loading />
                )
              ) : (
                <>
                  <Text className="text-muted-foreground">{t('supervisedAccess.limited')}</Text>
                  <Button onPress={() => router.push('/settings/experience')}>
                    {t('settings.experience')}
                  </Button>
                  <Button
                    appearance="plain"
                    tone="neutral"
                    onPress={() => showBottomSheet?.({ screen: 'Supervision' })}
                  >
                    {t('supervisedAccess.manage')}
                  </Button>
                </>
              )}
            </View>
          </View>
        )}
      </GestureHandlerRootView>
    </AppErrorBoundary>
  );
}
