import Head from 'expo-router/head';

import { ClarityChatRuntime } from '@/components/chat/clarity-chat-runtime';
import { ChatPageContent } from '@/components/chat-page-content';
import { useChatConversation } from '@/hooks/useChatConversation';

/** Clarity's home: a new search, whose first turn creates the conversation. */
function NewSearch() {
  const {
    messages,
    isLoading,
    scrollViewRef,
    createNewConversation,
    editMessage,
    clearConversation,
  } = useChatConversation();

  return (
    <ChatPageContent
      messages={messages}
      scrollViewRef={scrollViewRef}
      isLoading={isLoading}
      onSubmit={createNewConversation}
      onSuggestionPress={createNewConversation}
      onEditMessage={editMessage}
      onClear={clearConversation}
    />
  );
}

const SearchPage = () => (
  <>
    <Head>
      <title>Clarity | AI Search by Oxy</title>
      <meta
        name="description"
        content="Clarity is an AI-powered search engine by Oxy. Get answers with source citations, deep research, and follow-up questions."
      />
      <link rel="canonical" href="https://clarity.surf/" />
      <meta property="og:title" content="Clarity | AI Search by Oxy" />
      <meta
        property="og:description"
        content="Clarity is an AI-powered search engine by Oxy. Get answers with source citations, deep research, and follow-up questions."
      />
      <meta property="og:image" content="https://clarity.surf/og-image-default.png" />
    </Head>
    <ClarityChatRuntime>
      <NewSearch />
    </ClarityChatRuntime>
  </>
);

export default SearchPage;
