/**
 * The header of Clarity's conversation screen: the drawer on a narrow screen, who
 * takes part (the lead — Clarity's agent — and any agent it consulted, drawn by the
 * SDK's `AliaParticipants`), and a new conversation.
 */

import { AliaParticipants, type AliaChatChrome, type AliaChatState } from '@alia.onl/sdk';
import { GlyphButton } from '@oxy.so/bloom/button';
import { useRouter } from 'expo-router';
import { Menu, SquarePen } from 'lucide-react-native';
import { useCallback } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTranslation } from '@/hooks/useTranslation';
import { bloomIcon } from '@/lib/bloom-icon';
import { useUIStore } from '@/lib/stores/ui-store';

/** The `chrome` of `ClarityConversation`. */
export function useConversationChrome(): (state: AliaChatState) => AliaChatChrome {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isLargeScreen = width >= 768;
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);

  return useCallback(
    ({ participants, hasMessages }: AliaChatState) => ({
      header: (
        <View
          className="flex-row items-center gap-2 px-4"
          style={{ paddingTop: insets.top, height: 56 + insets.top }}
        >
          {isLargeScreen ? null : (
            <GlyphButton
              icon={bloomIcon(Menu)}
              glyphSize={20}
              onPress={() => setSidebarOpen(true)}
              accessibilityLabel={t('keyboardShortcuts.navigation')}
            />
          )}
          <View className="flex-1 min-w-0 items-center">
            <AliaParticipants participants={participants} />
          </View>
          <GlyphButton
            icon={bloomIcon(SquarePen)}
            glyphSize={20}
            disabled={!hasMessages}
            onPress={() => router.replace('/(app)')}
            accessibilityLabel={t('chat.newChat')}
          />
        </View>
      ),
    }),
    [insets.top, isLargeScreen, router, setSidebarOpen, t],
  );
}
