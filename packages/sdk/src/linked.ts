import { ClarityClient, type ClarityClientOptions } from './client.js';

/** Structural OxyServices boundary: this SDK never copies a session bearer. */
export interface ClaritySessionOwner {
  createLinkedClient(options: {
    baseURL: string;
    enableRetry?: boolean;
    requestTimeout?: number;
  }): {
    fetch: typeof fetch;
    dispose(): void;
  };
}

export function clarityForOxySession(
  oxy: ClaritySessionOwner,
  options: Pick<ClarityClientOptions, 'baseUrl' | 'timeoutMs'> = {},
): ClarityClient {
  const baseUrl = options.baseUrl ?? 'https://api.clarity.surf';
  return new ClarityClient({
    ...options,
    baseUrl,
    transport: oxy.createLinkedClient({ baseURL: baseUrl, requestTimeout: options.timeoutMs }),
  });
}
