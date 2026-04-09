import { useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import { LandingPage } from '@/components/landing-page';

export default function LoginScreen() {
  const { returnTo } = useLocalSearchParams();

  return (
    <>
      <Head>
        <title>Clarity - AI Search Engine</title>
        <meta
          name="description"
          content="Clarity is an AI-powered search engine. Ask anything and get clear, accurate answers."
        />
        <link rel="canonical" href="https://clarity.oxy.so/login" />
      </Head>
      <LandingPage
        returnTo={typeof returnTo === 'string' ? returnTo : undefined}
      />
    </>
  );
}
