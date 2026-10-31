import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { OxyProvider, useAccountColor } from '@oxy.so/services/ui/client';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { expoRouterScrollAdapter } from '@oxy.so/bloom/scroll/expo-router';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { OverlayInertBoundary, PortalOutlet, PortalProvider } from '@oxy.so/bloom/portal';

import { AppErrorBoundary } from '@/components/error-boundary';
import { useColorScheme } from '@/lib/useColorScheme';
import { BLOOM_THEME_PERSIST_KEY, BLOOM_THEME_STORAGE } from '@/lib/themePersistence';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from '@/lib/i18n';
import { useI18nStore } from '@/lib/stores/i18n-store';
import { handleLanguageError } from '@/lib/i18n/handleLanguageError';
import 'react-native-reanimated';
import '../global.css';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(app)',
};

SplashScreen.preventAutoHideAsync();

const OXY_API_URL = process.env.EXPO_PUBLIC_OXY_API_URL || 'https://api.oxy.so';
const AUTH_REDIRECT_URI = Linking.createURL('/');

function AppContent() {
  const { colors } = useColorScheme();
  useAccountColor();

  // OxyProvider mounts the one KeyboardProvider; a second one nested with it took the native keyboard events.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <PortalProvider>
        <OverlayInertBoundary>
          <Stack
            screenOptions={{
              contentStyle: {
                backgroundColor: colors.background,
              },
            }}
          >
            <Stack.Screen name="(app)" options={{ headerShown: false }} />
            <Stack.Screen name="(biglayout)" options={{ headerShown: false }} />
          </Stack>
        </OverlayInertBoundary>
        <PortalOutlet />
      </PortalProvider>
    </GestureHandlerRootView>
  );
}

function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
    Inter: require('../assets/fonts/Inter-VariableFont_opsz,wght.ttf'),
    'Inter-Italic': require('../assets/fonts/Inter-Italic-VariableFont_opsz,wght.ttf'),
    ...FontAwesome.font,
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) SplashScreen.hideAsync();
  }, [loaded]);

  if (!loaded) return null;

  return (
    <AppErrorBoundary>
      <BloomProvider
        scrollAdapter={expoRouterScrollAdapter}
        defaultMode="system"
        defaultColorPreset="yellow"
        persistKey={BLOOM_THEME_PERSIST_KEY}
        storage={BLOOM_THEME_STORAGE}
        fonts={false}
      >
        <OxyProvider
          baseURL={OXY_API_URL}
          clientId="oxy_dk_75cdd9996d19362e15ddedcc5ab0f4fb310de8d7b5e8523a"
          authRedirectUri={Platform.OS !== 'web' ? AUTH_REDIRECT_URI : undefined}
          language={{
            supportedLocales: SUPPORTED_LOCALES,
            fallbackLocale: DEFAULT_LOCALE,
            onChange: (locale) => useI18nStore.getState().setLocale(locale),
            onError: handleLanguageError,
          }}
        >
          <AppContent />
        </OxyProvider>
      </BloomProvider>
    </AppErrorBoundary>
  );
}

export default RootLayout;
