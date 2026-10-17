/**
 * What Clarity hands Alia's runtime, built once here: the search page's runtime
 * (`components/chat/clarity-chat-runtime.tsx`) and the app's one "Ask" sheet
 * (`components/chat/clarity-ask-provider.tsx`) read the same configuration.
 *
 *  - the words the runtime itself says (its toasts, its sheet), from Clarity's i18n;
 *  - `onFeatureLocked` — a feature gate of Clarity's agent refused (`deep_research`,
 *    `power_level.<level>`, `attachments.*`): Clarity's plans unlock them, so the
 *    answer is the subscribe screen.
 *
 * The conversation itself — history, titles, streaming, attachments — is Alia's.
 */

import type { AliaChatLabels } from '@alia.onl/sdk';
import { useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';

import { useTranslation } from '@/hooks/useTranslation';

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
