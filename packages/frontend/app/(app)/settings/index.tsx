import { View, ScrollView } from 'react-native';
import { useEffect } from 'react';
import { useOxy } from '@oxy.so/services';
import { useRouter } from 'expo-router';
import { useTranslation } from '@/hooks/useTranslation';
import { AccountSection } from '@/components/settings/account-section';
import { AliaSettingsLinks } from '@/components/settings/alia-settings-links';
import { SettingsHeader } from '@/components/settings/settings-header';

export default function SettingsAccountScreen() {
  const router = useRouter();
  const { isAuthenticated } = useOxy();
  const { t } = useTranslation();

  useEffect(() => {
    if (!isAuthenticated) {
      router.replace('/(app)');
    }
  }, [isAuthenticated]);

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t('settings.sections.account')} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl gap-6">
        <AccountSection />
        <AliaSettingsLinks />
      </ScrollView>
    </View>
  );
}
