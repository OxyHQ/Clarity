/**
 * A conversation with Clarity's agent, drawn by Alia's SDK
 * (`AliaChatContent agent={CLARITY_AGENT}`).
 *
 * `/` (a new conversation) and `/c/:id` mount this. Clarity brings only what is
 * Clarity's — its cards, its words, its suggestions, its upsell, the power level the
 * person picked — through `hooks/useClarityChat.ts`; the conversation, its history,
 * titles, voice, attachments and streaming are Alia's (Alia ADR 0018/0020). The turn
 * is paid by the person's own Alia credits.
 *
 * The route owns the address: a conversation the first turn creates replaces `/`
 * with `/c/:id`, and the SDK hands that turn to the conversation's own mount.
 */

import {
  ALIA_CHARACTER_RUNTIME_URL,
  AliaChatContent,
  type AliaChatContentProps,
  type AliaRuntimeHost,
} from '@alia.onl/sdk';
import { AgentAvatarProvider } from '@oxy.so/bloom/agent-avatar';
import { useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useClarityChat } from '@/hooks/useClarityChat';
import { CLARITY_AGENT, conversationPath } from '@/lib/clarity-agent';
import { faviconUrl } from '@/lib/sources';
import { useColorScheme } from '@/lib/useColorScheme';

export interface ClarityConversationProps {
  /** The conversation to show; omitted, a new one is made with the first turn. */
  conversationId?: string;
  /** What the screen draws around the thread. */
  chrome?: AliaChatContentProps['chrome'];
}

export function ClarityConversation({ conversationId, chrome }: ClarityConversationProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { isDarkColorScheme } = useColorScheme();
  const chat = useClarityChat();

  const openConversation = useCallback(
    (id: string) => {
      if (id !== conversationId) router.replace(conversationPath(id));
    },
    [conversationId, router],
  );
  const closeConversation = useCallback(() => {
    if (conversationId) router.replace('/');
  }, [conversationId, router]);

  const runtime = useMemo<AliaRuntimeHost>(
    () => ({
      openConversation,
      closeConversation,
      // The work log's sources show Clarity's stored copy of each site's icon.
      faviconUrl,
    }),
    [openConversation, closeConversation],
  );

  return (
    <AgentAvatarProvider runtimeUrl={ALIA_CHARACTER_RUNTIME_URL}>
      <AliaChatContent
        agent={CLARITY_AGENT}
        conversationId={conversationId}
        runtime={runtime}
        toolRenderers={chat.toolRenderers}
        labels={chat.labels}
        onFeatureLocked={chat.onFeatureLocked}
        model={chat.model}
        onModelChange={chat.onModelChange}
        welcomeSuggestions={chat.welcomeSuggestions}
        suggestionMatches={chat.suggestionMatches}
        onSuggestionQuery={chat.onSuggestionQuery}
        onSuggestionPicked={chat.onSuggestionPicked}
        chrome={chrome}
        isDarkMode={isDarkColorScheme}
        bottomInset={insets.bottom}
      />
    </AgentAvatarProvider>
  );
}
