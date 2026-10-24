import { useEffect, useMemo } from 'react';
import { clarityForOxySession } from '@clarity.surf/sdk';
import { useAuth } from '@oxy.so/services/ui/client';
import config from '../config';

/** Oxy owns refresh, session switching and origin-bound authenticated fetch. */
export function useExperienceClient() {
  const { oxyServices } = useAuth();
  const client = useMemo(
    () => clarityForOxySession(oxyServices, { baseUrl: config.apiUrl, timeoutMs: 15_000 }),
    [oxyServices],
  );
  useEffect(() => () => client.dispose(), [client]);
  return client.experience;
}
