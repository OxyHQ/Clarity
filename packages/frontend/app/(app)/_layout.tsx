import { useCallback, useMemo, useRef } from 'react';
import { Slot, usePathname } from 'expo-router';
import { AliaChatSheet, type AliaChatSheetRef } from '@alia.onl/sdk';
import { VoiceSession } from '@alia.onl/sdk/voice';
import { openAccountDialog, useOxy } from '@oxy.so/services';
import { SupervisedSurfaceGate } from '@/components/supervised-surface-gate';
import { AppShell } from '@oxy.so/bloom/app-shell';
import { useSearchSidebarConfig, useSettingsSidebarConfig } from '@/components/sidebar';
import { AppErrorBoundary } from '@/components/error-boundary';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useUIStore } from '@/lib/stores/ui-store';
import { useWelcomeSuggestions, useSessionSuggestionGeneration } from '@/lib/hooks/use-suggestions';
import { useNotificationSetup } from '@/lib/hooks/use-notification-setup';
import { useTranslation } from '@/hooks/useTranslation';

/**
 * Two branches, not one hook picking between two configs: each pulls in its
 * own data (conversations, account) via its own hooks, and React only runs
 * the hooks of the branch that's actually mounted for the current route.
 */
function SearchShell() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const { isAuthenticated } = useOxy();
  const aliaChatRef = useRef<AliaChatSheetRef>(null);

  // Signed out, Alia has no session to open: the press opens the Oxy sign-in dialog.
  const handleAskAlia = useCallback(() => {
    if (isAuthenticated) aliaChatRef.current?.present();
    else openAccountDialog();
  }, [isAuthenticated]);

  const sidebar = useSearchSidebarConfig({ onAskAlia: handleAskAlia });

  const aliaWelcomeSuggestions = useMemo(
    () => [
      { id: 'search', text: t('askAlia.suggestion.search') },
      { id: 'research', text: t('askAlia.suggestion.research') },
      { id: 'jobs', text: t('askAlia.suggestion.jobs') },
    ],
    [t],
  );

  // What the person is looking at, as far as the route says.
  const aliaClientContext = useMemo(() => {
    const screen = pathname.startsWith('/c/')
      ? 'onConversation'
      : pathname.startsWith('/discover')
        ? 'onDiscover'
        : pathname.startsWith('/jobs')
          ? 'onJobs'
          : pathname.startsWith('/history')
            ? 'onHistory'
            : 'onHome';
    return `${t('askAlia.clientContext')} ${t(`askAlia.${screen}`)}`;
  }, [pathname, t]);

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
      {isAuthenticated && (
        <AliaChatSheet
          ref={aliaChatRef}
          voiceSession={VoiceSession}
          clientContext={aliaClientContext}
          welcomeSuggestions={aliaWelcomeSuggestions}
        />
      )}
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

export default function AppLayout() {
  return (
    <SupervisedSurfaceGate experience>
      <OrdinaryAppLayout />
    </SupervisedSurfaceGate>
  );
}
