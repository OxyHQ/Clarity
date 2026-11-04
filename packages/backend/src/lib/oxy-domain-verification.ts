import { getErrorStatus } from '@oxy.so/core';
import type { OxyServer } from '@oxy.so/core/server';
import { z } from 'zod';

/** Oxy could not say whether the domain is verified. Never read as "not verified". */
export class DomainVerificationUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Oxy domain verification is unavailable', options);
    this.name = 'DomainVerificationUnavailableError';
  }
}

export interface DomainOwnershipQuery {
  readonly accountId: string;
  readonly verifiedDomainId: string;
  readonly originHost: string;
}

const verificationAnswer = z.object({ verified: z.boolean() });

/**
 * Whether `originHost` is covered by an Oxy verified domain that `accountId`
 * owns, asked as Clarity's workload through the one `OxyServer`.
 *
 * Oxy's 403 and 404 are answers: the domain is not this account's, or there is
 * no such domain. Anything else — an outage, a timeout, a refused service
 * token, a body that is not an answer — throws
 * {@link DomainVerificationUnavailableError}, so the route says 503 and the
 * caller retries, instead of being told its domain is not verified. Nothing
 * is cached, in either direction.
 */
export async function verifyOxyDomainOwnership(
  oxy: Pick<OxyServer, 'serviceRequest'>,
  query: DomainOwnershipQuery,
): Promise<boolean> {
  let answer: unknown;
  try {
    answer = await oxy.serviceRequest<unknown>(
      'POST',
      '/auth/resources/domains/verify',
      {
        accountId: query.accountId,
        verifiedDomainId: query.verifiedDomainId,
        originHost: query.originHost,
      },
      { cache: false, retry: false, timeout: 5_000 },
    );
  } catch (error) {
    const status = getErrorStatus(error);
    if (status === 403 || status === 404) return false;
    throw new DomainVerificationUnavailableError({ cause: error });
  }
  const parsed = verificationAnswer.safeParse(answer);
  if (!parsed.success) throw new DomainVerificationUnavailableError();
  return parsed.data.verified;
}
