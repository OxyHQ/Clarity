import { useMemo } from 'react';
import { ClarityClient } from '@clarity.surf/sdk';
import { useAuth } from '@oxy.so/services/ui/client';
import config from '../config';

/** The same canonical SDK and Oxy session boundary used by other editing surfaces. */
export function useExperienceClient() {
  const { oxyServices } = useAuth();
  return useMemo(() => {
    const transport = oxyServices.createLinkedClient({
      baseURL: config.apiUrl,
      enableRetry: false,
      requestTimeout: 15_000,
    }).client;
    return new ClarityClient({
      baseUrl: config.apiUrl,
      getAccessToken: () => oxyServices.http.getAccessToken() ?? '',
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        if (headers.get('authorization') !== `Bearer ${oxyServices.http.getAccessToken()}`)
          throw new Error('The request session changed');
        const method = init?.method;
        if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'DELETE')
          throw new Error('Unsupported experience request');
        return transport.requestAuthenticatedResponse({
          url: String(url),
          method,
          headers,
          body: init?.body ?? undefined,
          signal: init?.signal ?? undefined,
        });
      },
    }).experience;
  }, [oxyServices]);
}
