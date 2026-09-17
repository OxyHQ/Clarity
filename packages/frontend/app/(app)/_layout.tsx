import { Slot, usePathname } from 'expo-router';
import { AppShell } from '@oxy.so/bloom/app-shell';
import { useSearchSidebarConfig, useSettingsSidebarConfig } from '@/components/sidebar';
import { AppErrorBoundary } from '@/components/error-boundary';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useUIStore } from '@/lib/stores/ui-store';
import { useWelcomeSuggestions, useSessionSuggestionGeneration } from '@/lib/hooks/use-suggestions';
import { useNotificationSetup } from '@/lib/hooks/use-notification-setup';

/**
 * Two branches, not one hook picking between two configs: each pulls in its
 * own data (conversations, account) via its own hooks, and React only runs
 * the hooks of the branch that's actually mounted for the current route.
 */
function SearchShell() {
  const sidebar = useSearchSidebarConfig();
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  return (
    <AppShell sidebar={sidebar} header={<></>} drawerOpen={sidebarOpen} onDrawerOpenChange={setSidebarOpen}>
      <Slot />
    </AppShell>
  );
}

function SettingsShell() {
  const sidebar = useSettingsSidebarConfig();
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  return (
    <AppShell sidebar={sidebar} header={<></>} drawerOpen={sidebarOpen} onDrawerOpenChange={setSidebarOpen}>
      <Slot />
    </AppShell>
  );
}

export default function AppLayout() {
  const pathname = usePathname();
  const isSettingsRoute = pathname.startsWith('/settings');

  // Prefetch welcome suggestions so they're ready before any chat screen mounts
  useWelcomeSuggestions();
  useSessionSuggestionGeneration();

  // Push notification registration, tap handling, and real-time subscription
  useNotificationSetup();

  return (
    <AppErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {isSettingsRoute ? <SettingsShell /> : <SearchShell />}
      </GestureHandlerRootView>
    </AppErrorBoundary>
  );
}
