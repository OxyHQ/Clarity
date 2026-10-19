/**
 * The conversation Clarity's search page shows, as Alia's runtime keeps it.
 *
 * Everything that is the conversation — its messages, the stream, the first turn
 * that creates it, edits, stop, the attachments' upload, the app assertion — is
 * `useConversationThread` from `@alia.onl/sdk`, under `ClarityChatRuntime`. The page
 * adds only what is the page's: the scroll view it keeps at the bottom.
 */

import { useConversationThread } from '@alia.onl/sdk';
import { useCallback, useRef } from 'react';
import type { ScrollViewInstance } from 'react-native';

import { CLARITY_AGENT_ID } from '@/lib/clarity-agent';
import type { Attachment } from '@/lib/globalStore';
import { usePowerLevelStore } from '@/lib/stores/power-level-store';

export function useChatConversation({ conversationId }: { conversationId?: string } = {}) {
  const scrollViewRef = useRef<ScrollViewInstance>(null);
  const model = usePowerLevelStore((state) => state.powerLevel);
  const thread = useConversationThread({ conversationId, model, agentId: CLARITY_AGENT_ID });

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => scrollViewRef.current?.scrollToEnd({ animated: true }));
  }, []);

  const { sendMessage, createNewConversation, editMessage } = thread;
  const send = useCallback(
    (value: string, attachments?: Attachment[]) => {
      scrollToEnd();
      void sendMessage(value, attachments);
    },
    [sendMessage, scrollToEnd],
  );
  const start = useCallback(
    (value: string, attachments?: Attachment[]) => {
      void createNewConversation(value, attachments);
    },
    [createNewConversation],
  );
  const edit = useCallback(
    (messageId: string, content: string) => {
      scrollToEnd();
      void editMessage(messageId, content);
    },
    [editMessage, scrollToEnd],
  );

  return {
    conversationId,
    messages: thread.messages,
    isLoading: thread.isLoading,
    conversationLoading: thread.conversationLoading,
    error: thread.error,
    clearError: thread.clearError,
    scrollViewRef,
    /** A turn in the open conversation. */
    sendMessage: send,
    /** The first turn of a new search: the conversation it creates opens at `/c/:id`. */
    createNewConversation: start,
    editMessage: edit,
    stopGeneration: thread.stopGeneration,
    clearConversation: thread.clearConversation,
  };
}
