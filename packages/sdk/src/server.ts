import { ClarityClient, type ClarityClientOptions } from './client.js';

/** The receiving Clarity application, not the public sign-in registration. */
export const CLARITY_SERVICE_APPLICATION_ID = '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e';
export const CLARITY_SERVICE_AUDIENCE = `oxy-service:${CLARITY_SERVICE_APPLICATION_ID}` as const;

/** OxyServer owns attestation, refresh, origin binding and requester proof. */
export interface ClarityWorkloadOwner {
  createServiceClient(options: { baseURL: string; audience: typeof CLARITY_SERVICE_AUDIENCE }): {
    fetch: typeof fetch;
    dispose(): void;
  };
}

export function clarityForOxyService(
  oxy: ClarityWorkloadOwner,
  options: Pick<ClarityClientOptions, 'baseUrl' | 'timeoutMs'> = {},
): ClarityClient {
  const baseUrl = options.baseUrl ?? 'https://api.clarity.surf';
  return new ClarityClient({
    ...options,
    baseUrl,
    transport: oxy.createServiceClient({ baseURL: baseUrl, audience: CLARITY_SERVICE_AUDIENCE }),
  });
}
