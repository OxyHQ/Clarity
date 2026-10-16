import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { CLARITY_IDENTITY } from '../clarity-identity.js';
import {
  assertExactClarityServiceClaims,
  hasExactClarityServiceConfiguration,
} from '../clarity-service-auth.js';

const CLIENT_ID = CLARITY_IDENTITY.backendApplication.clientId;
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
   * The key pair is retired: the credential it authenticated is revoked. A
   * secret still reaching the process is refused even where the role could
   * attest, so a task definition that still injects one fails readiness
   * instead of carrying the pair along unnoticed.
   */
  it.each([
    ['beside the exact client id', { OXY_SERVICE_API_KEY: CLIENT_ID }],
    ['beside the exact client id on ECS', { OXY_SERVICE_API_KEY: CLIENT_ID, ...ON_ECS }],
    ['alone on ECS', ON_ECS],
    ['alone', {}],
  ])('refuses the retired secret %s', (_label, overrides) => {
    expect(
      hasExactClarityServiceConfiguration(
        env({ ...overrides, OXY_SERVICE_API_SECRET: 'a-retired-secret' }),
      ),
    ).toBe(false);
  });

  it('accepts a task that carries no secret but can attest its role', () => {
    // A leftover client id is tolerated (it is only a public id) while it is
    // still exactly Clarity's.
    expect(
      hasExactClarityServiceConfiguration(env({ OXY_SERVICE_API_KEY: CLIENT_ID, ...ON_ECS })),
    ).toBe(true);
    // And once the environment variable goes too.
    expect(hasExactClarityServiceConfiguration(env(ON_ECS))).toBe(true);
  });

  it('refuses a process with neither a secret nor anything to attest', () => {
    // A laptop. Readiness must keep reporting this rather than serving traffic
    // it cannot authenticate.
    expect(hasExactClarityServiceConfiguration(env())).toBe(false);
    expect(hasExactClarityServiceConfiguration(env({ OXY_SERVICE_API_KEY: CLIENT_ID }))).toBe(
      false,
    );
  });

  it('still pins a leftover client id byte for byte', () => {
    const foreign = 'oxy_dk_0000000000000000000000000000000000000000000000';
    // A foreign client id left behind is a deployment error even when nothing
    // would read it, so attestation does not excuse it.
    expect(
      hasExactClarityServiceConfiguration(env({ OXY_SERVICE_API_KEY: foreign, ...ON_ECS })),
    ).toBe(false);
    // Clarity's PUBLIC app is a different application; it must not mint here.
    expect(
      hasExactClarityServiceConfiguration(
        env({ OXY_SERVICE_API_KEY: CLARITY_IDENTITY.publicApplication.clientId, ...ON_ECS }),
      ),
    ).toBe(false);
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
});
