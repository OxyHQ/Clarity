/**
 * Everything a Clarity surface hands Alia's SDK, built once here: the conversation
 * screen (`components/chat/clarity-conversation.tsx`) and the app's one "Ask" sheet
 * (`components/chat/clarity-ask-provider.tsx`) read the same configuration.
 *
 *  - `toolRenderers` — the catalogue's results as Clarity's own cards;
 *  - `labels` — the chat's words from Clarity's i18n;
 *  - `onFeatureLocked` — a feature gate of Clarity's agent refused (`deep_research`,
 *    `power_level.<level>`, `attachments.*`): Clarity's plans unlock them, so the
 *    answer is the subscribe screen;
 *  - the power level the person picked;
 *  - Clarity's own suggestions (`/suggestions/*`) for the empty chat and the composer.
 *
 * The conversation itself — history, titles, streaming, voice, attachments — is Alia's.
 */

import type { AliaChatLabels, AliaSuggestion } from '@alia.onl/sdk';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';

import { CLARITY_TOOL_RENDERERS } from '@/components/chat/clarity-tool-renderers';
import { useTranslation } from '@/hooks/useTranslation';
import {
  useRecordSuggestionUsage,
  useSearchSuggestions,
  useWelcomeSuggestions,
} from '@/lib/hooks/use-suggestions';
import { usePowerLevelStore } from '@/lib/stores/power-level-store';
import { toAliaSuggestion } from '@/lib/suggestions';

/** The chat's own words, in the reader's language where Clarity has them. */
export function useClarityChatLabels(): Partial<AliaChatLabels> {
  const { t, locale } = useTranslation();
  return useMemo<Partial<AliaChatLabels>>(
    () => ({
      locale,
      placeholder: (leadName) => t('chat.placeholder', { name: leadName }),
      composerSend: t('chat.send'),
      composerStop: t('chat.stop'),
      newChat: t('chat.newChat'),
      share: t('chat.share'),
      back: t('common.back'),
      clear: t('chat.clear'),
    }),
    [t, locale],
  );
}

/** A feature gate refused: Clarity's plans are what unlock it. */
export function useFeatureLockedHandler(): (key: string) => void {
  const router = useRouter();
  return useCallback(() => router.push('/(biglayout)/subscribe'), [router]);
}

/** The SDK configuration of Clarity's conversation screen. */
export function useClarityChat() {
  const labels = useClarityChatLabels();
  const onFeatureLocked = useFeatureLockedHandler();
  const model = usePowerLevelStore((state) => state.powerLevel);
  const onModelChange = usePowerLevelStore((state) => state.setPowerLevel);

  const welcome = useWelcomeSuggestions();
  const welcomeSuggestions = useMemo<AliaSuggestion[] | undefined>(
    () => welcome.data?.map(toAliaSuggestion),
    [welcome.data],
  );

  const [query, setQuery] = useState('');
  const matches = useSearchSuggestions(query);
  const suggestionMatches = useMemo<AliaSuggestion[] | undefined>(
    () => matches.data?.map(toAliaSuggestion),
    [matches.data],
  );
  const { mutate: recordUse } = useRecordSuggestionUsage();
  const onSuggestionPicked = useCallback(
    (suggestion: AliaSuggestion) => recordUse(suggestion.id),
    [recordUse],
  );

  return {
    labels,
    toolRenderers: CLARITY_TOOL_RENDERERS,
    onFeatureLocked,
    model,
    onModelChange,
    // Clarity's pool, in the reader's language; when it has none, the agent's own starters.
    welcomeSuggestions: welcomeSuggestions?.length ? welcomeSuggestions : undefined,
    suggestionMatches,
    onSuggestionQuery: setQuery,
    onSuggestionPicked,
  };
}
