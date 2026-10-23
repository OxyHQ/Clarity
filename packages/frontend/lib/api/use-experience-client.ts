import { useMemo } from 'react';
import { clarityForOxySession } from '@clarity.surf/sdk';
import { useAuth } from '@oxy.so/services/ui/client';
import config from '../config';

/** Oxy owns refresh, session switching and origin-bound authenticated fetch. */
export function useExperienceClient() {
  const { oxyServices } = useAuth();
  return useMemo(
    () =>
      clarityForOxySession(oxyServices, { baseUrl: config.apiUrl, timeoutMs: 15_000 }).experience,
    [oxyServices],
  );
}
