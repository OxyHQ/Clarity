import { Slot, usePathname } from 'expo-router';
import { AppShell } from '@oxy.so/bloom/app-shell';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { ClarityAskProvider } from '@/components/chat/clarity-ask-provider';
import { SupervisedSurfaceGate } from '@/components/supervised-surface-gate';
import { AppErrorBoundary } from '@/components/error-boundary';
import { useSearchSidebarConfig, useSettingsSidebarConfig } from '@/components/sidebar';
import { useNotificationSetup } from '@/lib/hooks/use-notification-setup';
import { useUIStore } from '@/lib/stores/ui-store';

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
    <AppShell
      sidebar={sidebar}
      header={null}
      drawerOpen={sidebarOpen}
      onDrawerOpenChange={setSidebarOpen}
    >
      <Slot />
    </AppShell>
  );
}

function SettingsShell() {
  const sidebar = useSettingsSidebarConfig();
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  return (
    <AppShell
      sidebar={sidebar}
      header={null}
      drawerOpen={sidebarOpen}
      onDrawerOpenChange={setSidebarOpen}
    >
      <Slot />
    </AppShell>
  );
}

function OrdinaryAppLayout() {
  const pathname = usePathname();
  const isSettingsRoute = pathname.startsWith('/settings');

  // Push notification registration, tap handling, and real-time subscription
  useNotificationSetup();

  return (
    <AppErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/* The one "Ask" sheet (Alia, or Clarity's agent), above both shells. */}
        <ClarityAskProvider>
          {isSettingsRoute ? <SettingsShell /> : <SearchShell />}
        </ClarityAskProvider>
      </GestureHandlerRootView>
    </AppErrorBoundary>
  );
}

export default function AppLayout() {
  return (
    <SupervisedSurfaceGate experience>
      <OrdinaryAppLayout />
    </SupervisedSurfaceGate>
  );
}
