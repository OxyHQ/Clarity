import { View, useWindowDimensions } from 'react-native';
import { Text } from '@/components/ui/text';
import { GlyphButton } from '@oxy.so/bloom/button';
import { bloomIcon } from '@/lib/bloom-icon';
import { useTranslation } from '@/hooks/useTranslation';
import { useRouter } from 'expo-router';
import { Menu, ArrowLeft } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUIStore } from '@/lib/stores/ui-store';

interface SettingsHeaderProps {
  title: string;
  subtitle?: string;
  showBack?: boolean;
  onBack?: () => void;
}

export function SettingsHeader({ title, subtitle, showBack = false, onBack }: SettingsHeaderProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const { width } = useWindowDimensions();
  const isLargeScreen = width >= 768;
  const insets = useSafeAreaInsets();

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else {
      router.back();
    }
  };

  return (
    <View
      className="flex-row items-center gap-2 px-4 border-b border-border"
      style={{ paddingTop: insets.top, height: 56 + insets.top }}
    >
      {!isLargeScreen && (
        <GlyphButton
          icon={bloomIcon(Menu)}
          glyphSize={20}
          onPress={() => setSidebarOpen(true)}
          accessibilityLabel={t('keyboardShortcuts.navigation')}
        />
      )}
      {showBack && (
        <GlyphButton
          icon={bloomIcon(ArrowLeft)}
          glyphSize={20}
          onPress={handleBack}
          accessibilityLabel={t('common.back')}
        />
      )}
      <View className="flex-1">
        <Text className="text-lg font-bold">{title}</Text>
        {subtitle && <Text className="text-sm text-muted-foreground">{subtitle}</Text>}
      </View>
    </View>
  );
}
