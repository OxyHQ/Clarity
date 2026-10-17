import { useLocalSearchParams } from 'expo-router';

import { ClarityConversation } from '@/components/chat/clarity-conversation';
import { useConversationChrome } from '@/components/chat/conversation-header';

/** One of the person's conversations with Clarity's agent (Alia's, by id). */
const ChatConversationPage = () => {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chrome = useConversationChrome();
  // Keyed: another conversation is another mount, not this one re-pointed.
  return <ClarityConversation key={id} conversationId={id} chrome={chrome} />;
};

export default ChatConversationPage;
