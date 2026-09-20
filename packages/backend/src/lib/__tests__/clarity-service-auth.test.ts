import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { CLARITY_AGENT_MANIFEST } from '../clarity-agent-manifest.js';
import {
  assertExactClarityServiceClaims,
  hasExactClarityServiceConfiguration,
} from '../clarity-service-auth.js';

const CLIENT_ID = CLARITY_AGENT_MANIFEST.backendApplication.clientId;
const CREDENTIAL_ID = CLARITY_AGENT_MANIFEST.backendApplication.credentialId;
const ATTESTATION_ID = CLARITY_AGENT_MANIFEST.workloadIdentity.attestationId;

/** What ECS puts in a task's environment; its presence is what makes attesting possible. */
const ON_ECS = { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc-123' };

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { OXY_API_URL: 'https://api.oxy.so', ...overrides } as NodeJS.ProcessEnv;
}

function serviceToken(overrides: Record<string, unknown> = {}): string {
  const payload = {
    type: 'service',
    appId: CLARITY_AGENT_MANIFEST.backendApplication.applicationId,
    credentialId: CREDENTIAL_ID,
    ownerAccountId: CLARITY_AGENT_MANIFEST.projectAccountId,
    scopes: [...CLARITY_AGENT_MANIFEST.backendApplication.scopes],
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
      .update(CLARITY_AGENT_MANIFEST.workloadIdentity.roleArn)
      .digest('hex')
      .slice(0, 24)}`;
    expect(ATTESTATION_ID).toBe(derived);
    expect(ATTESTATION_ID).toMatch(/^wl_[0-9a-f]{24}$/);
  });

  it('names the dedicated Clarity task role, never the shared one', () => {
    // The shared `oxy-ecs-task` is bound to no application by design; a service
    // attesting it would have no identity at all.
    expect(CLARITY_AGENT_MANIFEST.workloadIdentity.roleArn)
      .toBe('arn:aws:iam::237343248947:role/oxy-clarity-task');
  });
});

describe('Clarity service configuration', () => {
  it('accepts the exact credential pair', () => {
    expect(hasExactClarityServiceConfiguration(
      env({ OXY_SERVICE_API_KEY: CLIENT_ID, OXY_SERVICE_API_SECRET: 'a-secret' }),
    )).toBe(true);
  });

  it('accepts a task that carries no secret but can attest its role', () => {
    // The state this migration produces: the client id stays behind as a plain
    // environment variable, only the secret is removed.
    expect(hasExactClarityServiceConfiguration(
      env({ OXY_SERVICE_API_KEY: CLIENT_ID, ...ON_ECS }),
    )).toBe(true);
    // And once the environment variable goes too.
    expect(hasExactClarityServiceConfiguration(env(ON_ECS))).toBe(true);
  });

  it('refuses a process with neither a secret nor anything to attest', () => {
    // A laptop. Readiness must keep reporting this rather than serving traffic
    // it cannot authenticate.
    expect(hasExactClarityServiceConfiguration(env())).toBe(false);
    expect(hasExactClarityServiceConfiguration(env({ OXY_SERVICE_API_KEY: CLIENT_ID }))).toBe(false);
  });

  it('still pins the client id byte for byte, in either mode', () => {
    const foreign = 'oxy_dk_0000000000000000000000000000000000000000000000';
    expect(hasExactClarityServiceConfiguration(
      env({ OXY_SERVICE_API_KEY: foreign, OXY_SERVICE_API_SECRET: 'a-secret' }),
    )).toBe(false);
    // A foreign client id left behind is a deployment error even when nothing
    // would read it, so attestation does not excuse it.
    expect(hasExactClarityServiceConfiguration(env({ OXY_SERVICE_API_KEY: foreign, ...ON_ECS }))).toBe(false);
    // Clarity's PUBLIC app is a different application; it must not mint here.
    expect(hasExactClarityServiceConfiguration(
      env({ OXY_SERVICE_API_KEY: CLARITY_AGENT_MANIFEST.publicApplication.clientId, ...ON_ECS }),
    )).toBe(false);
  });

  it('refuses a secret with no client id to pin it to', () => {
    expect(hasExactClarityServiceConfiguration(env({ OXY_SERVICE_API_SECRET: 'a-secret' }))).toBe(false);
  });

  it('keeps enforcing the canonical Oxy origin in production', () => {
    expect(hasExactClarityServiceConfiguration({
      NODE_ENV: 'production', OXY_API_URL: 'https://api.evil.example', ...ON_ECS,
    } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('Clarity service token claims', () => {
  it('accepts a credential-minted token', () => {
    expect(() => assertExactClarityServiceClaims(serviceToken())).not.toThrow();
  });

  it('accepts an attested token, which carries the handle in place of the credential id', () => {
    expect(() => assertExactClarityServiceClaims(
      serviceToken({ credentialId: ATTESTATION_ID }),
    )).not.toThrow();
  });

  /**
   * The negative this whole change turns on.
   *
   * Widening `credentialId` is the moment the identity assertion could quietly
   * become "any attested service", which would let every workload in the
   * account mint as Clarity. It accepts exactly two values and nothing else.
   */
  it('refuses another service’s attestation handle', () => {
    // Mention's task role, whose handle is a documented constant in oxy.
    const mention = `wl_${createHash('sha256')
      .update('arn:aws:iam::237343248947:role/oxy-mention-task')
      .digest('hex')
      .slice(0, 24)}`;
    expect(mention).toBe('wl_d61be5cd068abb658ed4d193');
    expect(mention).not.toBe(ATTESTATION_ID);
    expect(() => assertExactClarityServiceClaims(serviceToken({ credentialId: mention })))
      .toThrow('canonical Clarity service identity');
  });

  it.each([
    { name: 'a shared task role', credentialId: `wl_${createHash('sha256').update('arn:aws:iam::237343248947:role/oxy-ecs-task').digest('hex').slice(0, 24)}` },
    { name: 'a well-formed but unknown handle', credentialId: 'wl_000000000000000000000000' },
    { name: 'a handle prefix alone', credentialId: 'wl_' },
    { name: 'the handle with a suffix', credentialId: `${ATTESTATION_ID}x` },
    { name: 'Clarity’s public-app credential', credentialId: CLARITY_AGENT_MANIFEST.publicApplication.credentialId },
    { name: 'a missing credential id', credentialId: undefined },
    { name: 'a non-string credential id', credentialId: { id: ATTESTATION_ID } },
  ])('refuses $name', ({ credentialId }) => {
    expect(() => assertExactClarityServiceClaims(serviceToken({ credentialId })))
      .toThrow('canonical Clarity service identity');
  });

  it('still refuses a token from another application, payer or scope set', () => {
    const wrong = [
      { appId: CLARITY_AGENT_MANIFEST.publicApplication.applicationId },
      { ownerAccountId: CLARITY_AGENT_MANIFEST.botAccountId },
      { type: 'user' },
      { scopes: ['user:read'] },
      { scopes: ['user:read', 'inference:invoke', 'files:read'] },
      { scopes: ['user:read', 'user:read'] },
      { scopes: [] },
    ];
    for (const overrides of wrong) {
      // An attested token gets no more latitude than a credential-minted one.
      expect(() => assertExactClarityServiceClaims(serviceToken({ ...overrides, credentialId: ATTESTATION_ID })))
        .toThrow('canonical Clarity service identity');
      expect(() => assertExactClarityServiceClaims(serviceToken(overrides)))
        .toThrow('canonical Clarity service identity');
    }
  });
});
