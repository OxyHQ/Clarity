import { useEffect, useMemo } from 'react';
import { useOxy } from '@oxy.so/services/ui/client';
import type { LinkedHttpClient } from '@oxy.so/core';
import config from '../config';

/**
 * Returns a linked HTTP client tied to the current OxyServices session.
 *
 * The client mirrors the SDK bearer token automatically and delegates 401
 * refresh back to the session owner — no manual Authorization header needed.
 * Its GET/POST/PATCH/PUT/DELETE methods return the parsed response body directly,
 * not an axios-style `{ data }` wrapper.
 *
 * React Query / stores own cache invalidation for this client's resources.
 */
export function useApiClient(): LinkedHttpClient['client'] {
  const { oxyServices } = useOxy();
  const linked = useMemo(
    () => oxyServices.createLinkedClient({ baseURL: config.apiUrl }),
    [oxyServices],
  );
  useEffect(() => () => linked.dispose(), [linked]);
  return linked.client;
}
