import { Drawer } from 'expo-router/drawer';
import { Sidebar } from '@/components/sidebar';
import { AppErrorBoundary } from '@/components/error-boundary';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { View, useWindowDimensions } from 'react-native';
import { useCallback } from 'react';
import { useColorScheme } from '@/lib/useColorScheme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import i18n from '@/lib/i18n';
import { useWelcomeSuggestions, useSessionSuggestionGeneration } from '@/lib/hooks/use-suggestions';
import { useNotificationSetup } from '@/lib/hooks/use-notification-setup';

// Routes visible in the drawer sidebar
const VISIBLE_ROUTES = new Set(['c/[id]/index', 'settings/index']);

// Routes that handle their own top safe area insets
const SELF_INSET_ROUTES = new Set(['index', 'c/[id]/index', 'settings']);

export default function AppLayout() {
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;
  const { colors } = useColorScheme();
  const insets = useSafeAreaInsets();

  // Prefetch welcome suggestions so they're ready before any chat screen mounts
  useWelcomeSuggestions();
  useSessionSuggestionGeneration();

  // Push notification registration, tap handling, and real-time subscription
  useNotificationSetup();

  const renderDrawerContent = useCallback(() => <Sidebar />, []);

  const screenOptions = useCallback(({ route }: { route: { name: string } }) => ({
    headerShown: false,
    sceneContainerStyle: {
      paddingTop: SELF_INSET_ROUTES.has(route.name) || route.name.startsWith('settings/') ? 0 : insets.top,
    },
    drawerStyle: {
      width: 200,
      backgroundColor: colors.muted,
      borderRightWidth: 0,
      boxShadow: 'none' as const,
      elevation: 0,
    },
    drawerType: isLargeScreen ? ('permanent' as const) : ('front' as const),
    swipeEnabled: !isLargeScreen,
    overlayColor: isLargeScreen ? 'transparent' : 'rgba(0, 0, 0, 0.5)',
    drawerItemStyle: VISIBLE_ROUTES.has(route.name) ? undefined : { display: 'none' as const },
  }), [insets.top, colors.muted, isLargeScreen]);

  return (
    <AppErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/* root: isolate flex h-screen */}
        <View className="isolate flex h-screen flex-row">
          {/* main: isolate flex h-auto max-h-screen min-w-0 grow flex-col */}
          <View className="isolate flex h-auto max-h-screen min-w-0 grow flex-col">
            {/* content-area: relative isolate min-h-0 flex-1 overflow-hidden bg-background */}
            <View className="relative isolate min-h-0 flex-1 overflow-hidden bg-background">
              <Drawer
                drawerContent={renderDrawerContent}
                screenOptions={screenOptions}
              >
                <Drawer.Screen
                  name="c/[id]/index"
                  options={{
                    drawerLabel: i18n.t('nav.chat'),
                    title: i18n.t('nav.chat'),
                  }}
                />
                <Drawer.Screen
                  name="settings/index"
                  options={{
                    drawerLabel: i18n.t('nav.settings'),
                    title: i18n.t('nav.settings'),
                  }}
                />
              </Drawer>
            </View>
          </View>
        </View>
      </GestureHandlerRootView>
    </AppErrorBoundary>
  );
}
