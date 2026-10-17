import Head from 'expo-router/head';

import { ClarityConversation } from '@/components/chat/clarity-conversation';
import { useConversationChrome } from '@/components/chat/conversation-header';

/** Clarity's home: a new conversation with its agent, made by the first turn. */
const SearchPage = () => {
  const chrome = useConversationChrome();
  return (
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
      <ClarityConversation chrome={chrome} />
    </>
  );
};

export default SearchPage;
