import React from 'react';
import { View, Pressable } from 'react-native';
import { vars } from 'nativewind';
import { Text } from '@/components/ui/text';
import { useColorScheme } from '@/lib/useColorScheme';
import { useTranslation } from '@/hooks/useTranslation';
import { LanguageSelector } from '@/components/language-selector';
import { COLOR_PRESET_REGISTRY, type AppColorName } from '@oxy.so/bloom/theme';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { toast } from '@oxy.so/bloom/toast';
import { useAccountColorSave } from '@oxy.so/services/ui/client';
import { getPresetVars } from '@oxy.so/bloom/design-tokens';

/** Miniature app layout using real theme tokens via NativeWind vars() */
const AppMiniature = React.memo(function AppMiniature({
  variant,
  colorName,
}: {
  variant: 'light' | 'dark';
  colorName: AppColorName;
}) {
  const themeVars = vars(getPresetVars(colorName, variant));

  return (
    <View className="flex-row flex-1 rounded overflow-hidden" style={themeVars}>
      {/* Sidebar */}
      <View className="bg-sidebar p-1 gap-0.5 justify-between" style={{ width: '27%' }}>
        <View className="gap-0.5">
          <View className="h-1.5 rounded-sm bg-primary" />
          <View className="h-[1px] w-3/4 rounded-full mt-0.5 bg-sidebar-border" />
          <View className="h-[1px] w-2/3 rounded-full bg-sidebar-border" />
          <View className="h-[1px] w-3/4 rounded-full bg-sidebar-border" />
          <View className="h-[1px] w-1/2 rounded-full bg-sidebar-border" />
        </View>
        <View className="gap-0.5">
          <View className="h-[1px] w-2/3 rounded-full bg-sidebar-border" />
          <View className="h-[1px] w-3/4 rounded-full bg-sidebar-border" />
        </View>
      </View>
      {/* Main content */}
      <View className="flex-1 bg-background justify-between">
        {/* Chat header */}
        <View className="flex-row items-center justify-between px-1 py-0.5">
          <View className="h-[2px] w-1/4 rounded-full bg-border" />
          <View className="h-[2px] w-2 rounded-full bg-border" />
        </View>
        {/* Greeting */}
        <View className="items-center gap-0.5">
          <View className="h-[2px] w-3/5 rounded-full bg-muted-foreground" />
          <View className="h-[1px] w-2/5 rounded-full bg-border" />
        </View>
        {/* Suggestion cards 2x2 */}
        <View className="gap-[2px] px-1">
          <View className="flex-row gap-[2px]">
            <View className="flex-1 h-1.5 rounded-sm bg-muted" />
            <View className="flex-1 h-1.5 rounded-sm bg-muted" />
          </View>
          <View className="flex-row gap-[2px]">
            <View className="flex-1 h-1.5 rounded-sm bg-muted" />
            <View className="flex-1 h-1.5 rounded-sm bg-muted" />
          </View>
        </View>
        {/* Input bar */}
        <View className="px-1 pb-0.5 gap-[2px]">
          <View className="flex-row gap-[2px]">
            <View className="h-1 w-3 rounded-full bg-primary/50" />
            <View className="h-1 w-2 rounded-full bg-border" />
          </View>
          <View className="h-2 rounded-sm bg-muted" />
        </View>
      </View>
    </View>
  );
});

function colorLabel(name: AppColorName): string {
  return COLOR_PRESET_REGISTRY.find((preset) => preset.name === name)?.displayName ?? name;
}

export function GeneralSection() {
  const { mode, setColorScheme } = useColorScheme();
  const { colors, value: appColor, saveColor, saving } = useAccountColorSave();
  const colorOptions = colors.map((name) => ({ value: name, label: colorLabel(name) }));
  const { t } = useTranslation();

  return (
    <View className="gap-5">
      {/* App Language */}
      <LanguageSelector />

      {/* Appearance */}
      <View className="gap-2">
        <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
          {t('settings.appearance.title')}
        </Text>

        <View className="flex-row gap-2">
          {/* Light */}
          <Pressable onPress={() => setColorScheme('light')} className="flex-1">
            <View
              className={`rounded-lg p-1.5 ${
                mode === 'light' ? 'border-2 border-primary' : 'border border-border'
              }`}
            >
              <View className="mb-1.5 aspect-[5/3]">
                <AppMiniature variant="light" colorName={appColor} />
              </View>
              <Text className="text-center text-xs font-medium text-foreground">
                {t('settings.appearance.light')}
              </Text>
            </View>
          </Pressable>

          {/* Follow System */}
          <Pressable onPress={() => setColorScheme('system')} className="flex-1">
            <View
              className={`rounded-lg p-1.5 ${
                mode === 'system' ? 'border-2 border-primary' : 'border border-border'
              }`}
            >
              <View className="rounded overflow-hidden mb-1.5 aspect-[5/3]">
                <View className="flex-row flex-1">
                  <View className="flex-1 overflow-hidden">
                    <AppMiniature variant="light" colorName={appColor} />
                  </View>
                  <View className="flex-1 overflow-hidden">
                    <AppMiniature variant="dark" colorName={appColor} />
                  </View>
                </View>
              </View>
              <Text className="text-center text-xs font-medium text-foreground">
                {t('settings.appearance.system')}
              </Text>
            </View>
          </Pressable>

          {/* Dark */}
          <Pressable onPress={() => setColorScheme('dark')} className="flex-1">
            <View
              className={`rounded-lg p-1.5 ${
                mode === 'dark' ? 'border-2 border-primary' : 'border border-border'
              }`}
            >
              <View className="mb-1.5 aspect-[5/3]">
                <AppMiniature variant="dark" colorName={appColor} />
              </View>
              <Text className="text-center text-xs font-medium text-foreground">
                {t('settings.appearance.dark')}
              </Text>
            </View>
          </Pressable>
        </View>
      </View>

      {/* Account colour */}
      <View className="gap-2">
        <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
          {t('settings.accentColor.title')}
        </Text>
        <Select
          value={appColor}
          disabled={saving}
          onValueChange={(name) => {
            const next = colors.find((color) => color === name);
            if (!next) return;
            saveColor(next).catch(() => toast.error(t('settings.accentColor.saveFailed')));
          }}
        >
          <SelectTrigger label={t('settings.accentColor.title')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            items={colorOptions}
            renderItem={(option) => (
              <SelectItem value={option.value} label={option.label}>
                <SelectItemText>{option.label}</SelectItemText>
              </SelectItem>
            )}
          />
        </Select>
      </View>
    </View>
  );
}
