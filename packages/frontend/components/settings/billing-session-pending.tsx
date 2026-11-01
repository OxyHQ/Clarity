import { View } from 'react-native';
import { useOxy } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@/components/ui/text';
import { useTranslation } from '@/hooks/useTranslation';

/** Account recovery stays with the shared Oxy account dialog. */
export function BillingSessionPending() {
  const { openAccountDialog } = useOxy();
  const { t } = useTranslation();
  return (
    <View className="gap-3 py-6">
      <Text>{t('billing.sessionPending')}</Text>
      <Button onPress={() => openAccountDialog()}>{t('settings.account.title')}</Button>
    </View>
  );
}
