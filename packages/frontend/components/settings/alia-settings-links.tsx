import { Linking, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { ExternalLink } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { useTranslation } from '@/hooks/useTranslation';
import { bloomIcon } from '@/lib/bloom-icon';

/** Alia's own settings, where the person manages what is Alia's and not Clarity's. */
const ALIA_SETTINGS = {
  usage: 'https://alia.onl/settings/usage',
  memory: 'https://alia.onl/settings/memory',
  bots: 'https://alia.onl/settings/bots',
  security: 'https://alia.onl/settings/security',
} as const;

/**
 * Clarity's assistant is an Alia agent: the person's credits and usage, what Alia
 * remembers, the channels they chat from and the agent audit are Alia's, managed
 * in Alia. This is the way there.
 */
export function AliaSettingsLinks() {
  const { t } = useTranslation();
  return (
    <View className="border border-border rounded-xl p-3 gap-3">
      <View className="gap-1">
        <Text className="text-sm font-semibold text-foreground">{t('settings.alia.title')}</Text>
        <Text className="text-xs text-muted-foreground">{t('settings.alia.description')}</Text>
      </View>
      <View className="flex-row flex-wrap gap-2">
        {(Object.keys(ALIA_SETTINGS) as (keyof typeof ALIA_SETTINGS)[]).map((key) => (
          <Button
            key={key}
            appearance="outline"
            tone="neutral"
            size="sm"
            trailingIcon={bloomIcon(ExternalLink)}
            onPress={() => void Linking.openURL(ALIA_SETTINGS[key])}
          >
            {t(`settings.alia.${key}`)}
          </Button>
        ))}
      </View>
    </View>
  );
}
