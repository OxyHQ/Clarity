import { useLocalSearchParams } from 'expo-router';

import { ClarityChatRuntime } from '@/components/chat/clarity-chat-runtime';
import { ChatPageContent } from '@/components/chat-page-content';
import { UsageLimitDialog } from '@/components/usage-limit-dialog';
import { useChatConversation } from '@/hooks/useChatConversation';

function Conversation({ conversationId }: { conversationId: string }) {
  const {
    messages,
    isLoading,
    conversationLoading,
    error,
    scrollViewRef,
    sendMessage,
    editMessage,
    stopGeneration,
    clearConversation,
    clearError,
  } = useChatConversation({ conversationId });

  return (
    <>
      <ChatPageContent
        conversationId={conversationId}
        messages={messages}
        scrollViewRef={scrollViewRef}
        isLoading={isLoading}
        conversationLoading={conversationLoading}
        onSubmit={sendMessage}
        onSuggestionPress={sendMessage}
        onEditMessage={editMessage}
        onStop={stopGeneration}
        onClear={clearConversation}
      />
      <UsageLimitDialog error={error} onDismiss={clearError} />
    </>
  );
}

/** A conversation with Clarity: Alia keeps it, Clarity draws it. */
const ChatConversationPage = () => {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <ClarityChatRuntime conversationId={id}>
      <Conversation conversationId={id} />
    </ClarityChatRuntime>
  );
};

export default ChatConversationPage;
