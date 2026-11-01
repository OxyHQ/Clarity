import { View, ScrollView } from 'react-native';
import { useTranslation } from '@/hooks/useTranslation';
import { BillingSection } from '@/components/settings/billing-section';
import { SettingsHeader } from '@/components/settings/settings-header';

export default function SettingsBillingScreen() {
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t('settings.sections.billing')} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <BillingSection />
      </ScrollView>
    </View>
  );
}
