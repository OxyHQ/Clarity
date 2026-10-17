/**
 * Share a search: Alia mints the link (`https://alia.onl/shared/<token>`, 24 hours),
 * the one address a shared conversation has whichever app it was started in. Native
 * hands it to the system share sheet; the web copies it.
 */

import { useShareConversation } from '@alia.onl/sdk';
import { toast } from '@oxy.so/bloom/toast';
import * as Clipboard from 'expo-clipboard';
import { useCallback } from 'react';
import { Platform, Share } from 'react-native';

import { useTranslation } from '@/hooks/useTranslation';

export function useShareSearch(conversationId: string | undefined) {
  const { t } = useTranslation();
  const { share } = useShareConversation();

  return useCallback(async () => {
    if (!conversationId) {
      toast.info(t('chatHeader.shareNothingYet'));
      return;
    }
    try {
      const { url } = await share(conversationId);
      if (Platform.OS === 'web') {
        await Clipboard.setStringAsync(url);
        toast.success(t('chatHeader.shareCopied'));
      } else {
        await Share.share({ message: url, url });
      }
    } catch {
      toast.error(t('chatHeader.shareFailed'));
    }
  }, [conversationId, share, t]);
}
