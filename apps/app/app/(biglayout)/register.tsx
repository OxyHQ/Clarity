import Head from 'expo-router/head';
import { LandingPage } from '@/components/landing-page';

export default function RegisterScreen() {
  return (
    <>
      <Head>
        <title>Sign Up - Clarity</title>
        <meta
          name="description"
          content="Create your free Clarity account. No credit card required."
        />
        <link rel="canonical" href="https://clarity.oxy.so/register" />
      </Head>
      <LandingPage />
    </>
  );
}
