import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { CLARITY_IDENTITY } from '../clarity-identity.js';
import {
  assertExactClarityServiceClaims,
  hasExactClarityServiceConfiguration,
} from '../clarity-service-auth.js';
import { CLARITY_FILES_SCOPES } from '../../files/oxy-files.js';

/** The retired backend credential's public client id. */
const RETIRED_CLIENT_ID = 'oxy_dk_8c84c74a2656b8f5147d4d0b65fcd0e88c192ce64f465f78';
/** The backend credential retired with its key pair (oxy ADR 0026); no token naming it is Clarity's. */
const RETIRED_CREDENTIAL_ID = '01a0648b-8d74-7240-adba-80707fdfdf9c';
const ATTESTATION_ID = CLARITY_IDENTITY.workloadIdentity.attestationId;

/** What ECS puts in a task's environment; its presence is what makes attesting possible. */
const ON_ECS = { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc-123' };

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { OXY_API_URL: 'https://api.oxy.so', ...overrides } as NodeJS.ProcessEnv;
}

function serviceToken(overrides: Record<string, unknown> = {}): string {
  const payload = {
    type: 'service',
    appId: CLARITY_IDENTITY.backendApplication.applicationId,
    credentialId: ATTESTATION_ID,
    ownerAccountId: CLARITY_IDENTITY.projectAccountId,
    scopes: [...CLARITY_IDENTITY.backendApplication.scopes],
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

/**
 * The pinned handle must stay derivable, not merely asserted.
 *
 * Oxy computes the token's `credentialId` for an attested mint as `wl_` plus 96
 * bits of SHA-256 over the CANONICAL role ARN, and Clarity pins the result. Two
 * copies of a constant agree the day they are written; this recomputes ours
 * from the role it claims to describe, so a typo in either — or a change of
 * task role — reddens here instead of rejecting every token in production.
 */
describe('the pinned workload attestation handle', () => {
  it('is exactly what oxy derives from the task role ARN', () => {
    const derived = `wl_${createHash('sha256')
      .update(CLARITY_IDENTITY.workloadIdentity.roleArn)
      .digest('hex')
      .slice(0, 24)}`;
    expect(ATTESTATION_ID).toBe(derived);
    expect(ATTESTATION_ID).toMatch(/^wl_[0-9a-f]{24}$/);
  });

  it('names the dedicated Clarity task role, never the shared one', () => {
    // The shared `oxy-ecs-task` is bound to no application by design; a service
    // attesting it would have no identity at all.
    expect(CLARITY_IDENTITY.workloadIdentity.roleArn).toBe(
      'arn:aws:iam::237343248947:role/oxy-clarity-task',
    );
  });
});

describe('Clarity service configuration', () => {
  /**
   * The key pair is retired: the credential it authenticated is revoked. Either
   * half still reaching the process is refused even where the role could
   * attest, so a task definition that still injects one fails readiness
   * instead of carrying the pair along unnoticed.
   */
  it.each([
    ['OXY_SERVICE_API_SECRET', 'a-retired-secret'],
    ['OXY_SERVICE_API_KEY', RETIRED_CLIENT_ID],
    ['OXY_SERVICE_API_KEY', CLARITY_IDENTITY.publicApplication.clientId],
  ])('refuses a retired %s, on ECS or not', (name, value) => {
    expect(hasExactClarityServiceConfiguration(env({ [name]: value, ...ON_ECS }))).toBe(false);
    expect(hasExactClarityServiceConfiguration(env({ [name]: value }))).toBe(false);
  });

  it('accepts a task that carries neither half of the pair and can attest its role', () => {
    expect(hasExactClarityServiceConfiguration(env(ON_ECS))).toBe(true);
    // An empty value is what an unset variable looks like in some runners.
    expect(hasExactClarityServiceConfiguration(env({ OXY_SERVICE_API_KEY: '', ...ON_ECS }))).toBe(
      true,
    );
  });

  it('refuses a process with nothing to attest', () => {
    // A laptop. Readiness must keep reporting this rather than serving traffic
    // it cannot authenticate.
    expect(hasExactClarityServiceConfiguration(env())).toBe(false);
  });

  it('keeps enforcing the canonical Oxy origin in production', () => {
    expect(
      hasExactClarityServiceConfiguration({
        NODE_ENV: 'production',
        OXY_API_URL: 'https://api.evil.example',
        ...ON_ECS,
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe('Clarity service token claims', () => {
  it('refuses a token minted by the retired backend credential', () => {
    expect(() =>
      assertExactClarityServiceClaims(serviceToken({ credentialId: RETIRED_CREDENTIAL_ID })),
    ).toThrow('canonical Clarity service identity');
  });

  it('accepts an attested token, which carries the handle in place of the credential id', () => {
    expect(() =>
      assertExactClarityServiceClaims(serviceToken({ credentialId: ATTESTATION_ID })),
    ).not.toThrow();
  });

  /**
   * The negative this whole change turns on.
   *
   * Widening `credentialId` is the moment the identity assertion could quietly
   * become "any attested service", which would let every workload in the
   * account mint as Clarity. It accepts exactly one value and nothing else.
   */
  it('refuses another service’s attestation handle', () => {
    // Mention's task role, whose handle is a documented constant in oxy.
    const mention = `wl_${createHash('sha256')
      .update('arn:aws:iam::237343248947:role/oxy-mention-task')
      .digest('hex')
      .slice(0, 24)}`;
    expect(mention).toBe('wl_d61be5cd068abb658ed4d193');
    expect(mention).not.toBe(ATTESTATION_ID);
    expect(() => assertExactClarityServiceClaims(serviceToken({ credentialId: mention }))).toThrow(
      'canonical Clarity service identity',
    );
  });

  it.each([
    {
      name: 'a shared task role',
      credentialId: `wl_${createHash('sha256').update('arn:aws:iam::237343248947:role/oxy-ecs-task').digest('hex').slice(0, 24)}`,
    },
    { name: 'a well-formed but unknown handle', credentialId: 'wl_000000000000000000000000' },
    { name: 'a handle prefix alone', credentialId: 'wl_' },
    { name: 'the handle with a suffix', credentialId: `${ATTESTATION_ID}x` },
    {
      name: 'Clarity’s public-app credential',
      credentialId: CLARITY_IDENTITY.publicApplication.credentialId,
    },
    { name: 'a missing credential id', credentialId: undefined },
    { name: 'a non-string credential id', credentialId: { id: ATTESTATION_ID } },
  ])('refuses $name', ({ credentialId }) => {
    expect(() => assertExactClarityServiceClaims(serviceToken({ credentialId }))).toThrow(
      'canonical Clarity service identity',
    );
  });

  it('still refuses a token from another application, payer or scope set', () => {
    const wrong = [
      { appId: CLARITY_IDENTITY.publicApplication.applicationId },
      // The Clarity agent's bot account: a token it pays for is not the backend's.
      { ownerAccountId: '01a0646a-078f-7120-a993-a03c180c81b0' },
      { type: 'user' },
      { scopes: ['user:read'] },
      // The scope set before the capability catalogue: one the backend no longer runs on.
      { scopes: ['user:read', 'inference:invoke'] },
      { scopes: [...CLARITY_IDENTITY.backendApplication.scopes, 'files:read'] },
      {
        scopes: [
          ...CLARITY_IDENTITY.backendApplication.scopes.slice(1),
          CLARITY_IDENTITY.backendApplication.scopes[1],
        ],
      },
      { scopes: [] },
    ];
    for (const overrides of wrong) {
      // The right handle buys no latitude on any other claim.
      expect(() => assertExactClarityServiceClaims(serviceToken(overrides))).toThrow(
        'canonical Clarity service identity',
      );
    }
  });
  /**
   * Once Oxy grants Clarity's file scopes, the workload's FULL grant is the
   * backend's declared tuple plus `CLARITY_FILES_SCOPES`. That token is what the
   * Oxy Files adapter's calls carry (an unscoped mint, cached apart from the
   * scoped one), and it must never pass as the backend token checked exactly:
   * that token is minted as the exact subset, so granting files leaves it unchanged.
   */
  it('refuses the full grant once the file scopes are added, so the backend token stays the exact subset', () => {
    const backendScopes: readonly string[] = CLARITY_IDENTITY.backendApplication.scopes;
    expect(CLARITY_FILES_SCOPES.some((scope) => backendScopes.includes(scope))).toBe(false);
    expect(() =>
      assertExactClarityServiceClaims(
        serviceToken({ scopes: [...backendScopes, ...CLARITY_FILES_SCOPES] }),
      ),
    ).toThrow('canonical Clarity service identity');
  });
});
