/**
 * "Ask Alia" (and "Ask Clarity"): the SDK's one sheet, mounted once around the app
 * frame. Anything below calls `useAskAgent().ask('alia' | 'clarity', turn?)` from
 * `@alia.onl/sdk`; signed out, the SDK opens Oxy's sign-in instead.
 *
 * The sheet floats over whatever page the person was reading, so it is told which
 * page that is (`clientContext`). Clarity's cards draw Clarity's tool results in it,
 * whoever called the tool — Clarity's agent, or Alia consulting it.
 */

import { AliaAskProvider, type AliaSuggestion } from '@alia.onl/sdk';
import { usePathname } from 'expo-router';
import type React from 'react';
import { useMemo } from 'react';

import { CLARITY_TOOL_RENDERERS } from '@/components/chat/clarity-tool-renderers';
import { useClarityChatLabels, useFeatureLockedHandler } from '@/hooks/useClarityChat';
import { useTranslation } from '@/hooks/useTranslation';
import { CLARITY_ASK_AGENTS } from '@/lib/clarity-agent';
import { usePowerLevelStore } from '@/lib/stores/power-level-store';

/** Where the person is, as far as the route says. */
function screenOf(pathname: string): string {
  if (pathname.startsWith('/c/')) return 'onConversation';
  if (pathname.startsWith('/discover')) return 'onDiscover';
  if (pathname.startsWith('/jobs')) return 'onJobs';
  if (pathname.startsWith('/finance')) return 'onFinance';
  if (pathname.startsWith('/history')) return 'onHistory';
  return 'onHome';
}

export function ClarityAskProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const labels = useClarityChatLabels();
  const onFeatureLocked = useFeatureLockedHandler();
  const model = usePowerLevelStore((state) => state.powerLevel);

  // Alia's lines over her empty composer; Clarity's agent offers its own starters.
  const welcomeSuggestions = useMemo<AliaSuggestion[]>(
    () => [
      { id: 'search', text: t('askAlia.suggestion.search') },
      { id: 'research', text: t('askAlia.suggestion.research') },
      { id: 'jobs', text: t('askAlia.suggestion.jobs') },
    ],
    [t],
  );

  const clientContext = useMemo(
    () => `${t('askAlia.clientContext')} ${t(`askAlia.${screenOf(pathname)}`)}`,
    [pathname, t],
  );

  return (
    <AliaAskProvider
      agents={CLARITY_ASK_AGENTS}
      toolRenderers={CLARITY_TOOL_RENDERERS}
      labels={labels}
      clientContext={clientContext}
      onFeatureLocked={onFeatureLocked}
      model={model}
      welcomeSuggestions={welcomeSuggestions}
    >
      {children}
    </AliaAskProvider>
  );
}
