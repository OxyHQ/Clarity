import config from '../config';

/**
 * A request to one of Clarity's PUBLIC product surfaces — Jobs and the market
 * quotes behind Finance.
 *
 * These carry no session and no user identity, which is the mechanism behind
 * the privacy rule rather than a convenience: searching a listing never
 * identifies a person to an employer, and reading a price never identifies one
 * at all. Anything that needs a signed-in user goes through `useApiClient`
 * instead, which mirrors the Oxy bearer.
 *
 * The backend answers failures in one envelope (`{ error: { code, message } }`),
 * so it is read in one place: a surface that parsed it differently would
 * eventually report a rate limit as an unknown outage.
 */
export async function requestPublicApi<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
    throw new Error(body?.error?.message ?? `Clarity request failed with ${response.status}`);
  }
  return await response.json() as T;
}
