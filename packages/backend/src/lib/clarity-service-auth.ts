import { createHash } from 'node:crypto';
import { OxyServices } from '@oxy.so/core';
import { canAttestWorkloadIdentity } from '@oxy.so/core/server';

import { CLARITY_AGENT_MANIFEST } from './clarity-agent-manifest.js';

export class ClarityServiceConfigurationError extends Error {}

interface ServiceTokenClaims {
  type?: unknown;
  appId?: unknown;
  credentialId?: unknown;
  ownerAccountId?: unknown;
  scopes?: unknown;
  exp?: unknown;
}

const TOKEN_EXPIRY_CLOCK_SKEW_SECONDS = 30;

let client: OxyServices | undefined;
let clientFingerprint = '';
const CANONICAL_OXY_API_URL = 'https://api.oxy.so';

/**
 * How this process authenticates to Oxy.
 *
 * `credential` is the api key/secret pair. `attestation` is oxy ADR 0026: no
 * secret at all — the task signs an STS `GetCallerIdentity` request with its
 * ECS task role and Oxy mints the same service token from it.
 */
type ClarityServiceConfiguration =
  | { mode: 'credential'; publicKey: string; secret: string; baseUrl: string }
  | { mode: 'attestation'; baseUrl: string };

function requireExact(value: string | undefined, expected: string, name: string): string {
  if (value !== expected) throw new ClarityServiceConfigurationError(`${name} does not match the canonical Clarity identity.`);
  return value;
}

function canonicalBaseUrl(env: NodeJS.ProcessEnv): string {
  const rawBaseUrl = env.OXY_API_URL || CANONICAL_OXY_API_URL;
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new ClarityServiceConfigurationError('OXY_API_URL is not a valid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ClarityServiceConfigurationError('OXY_API_URL must use HTTP or HTTPS.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new ClarityServiceConfigurationError('OXY_API_URL must be a plain origin.');
  }
  if (env.NODE_ENV === 'production' && parsed.origin !== CANONICAL_OXY_API_URL) {
    throw new ClarityServiceConfigurationError('Production OXY_API_URL must use the canonical Oxy origin.');
  }
  return parsed.origin;
}

/**
 * Which identity this process may present, and on what evidence.
 *
 * ## Why the api key is no longer what proves who we are
 *
 * This function used to REQUIRE `OXY_SERVICE_API_KEY` to equal the manifest's
 * client id, and that check was doing real work: Clarity pins its own identity
 * byte for byte and must never mint under another application. But the evidence
 * it read was an environment variable this process set for itself, which proves
 * only what we were told. Under attestation there is no pair at all, so the
 * check is not merely unnecessary there — it is unsatisfiable, and keeping it
 * would mean Clarity could never stop holding a secret.
 *
 * The assertion therefore moves to where it is actually PROVABLE:
 * {@link assertExactClarityServiceClaims} reads the token Oxy just returned and
 * refuses anything whose app, payer, credential and scope set are not exactly
 * Clarity's. That is strictly stronger — it catches a credential that was
 * re-pointed at another application, which the environment check never could —
 * and it is the check that now runs on every mint in both modes.
 *
 * What is kept here is the part that is still about THIS process: whenever a
 * client id is present it must be Clarity's, in either mode. A stale or foreign
 * client id left in the environment is a deployment error worth refusing even
 * when nothing would read it.
 *
 * ## Why the secret, not the key, selects the mode
 *
 * The pair's secret is the thing that can actually mint. The task definition
 * carries the client id as a plain environment variable and the secret as an
 * ECS secret, and the migration removes only the secret — so "key present,
 * secret absent" is the real, expected steady state on the way through, not a
 * half-configuration to reject. `@oxy.so/core` agrees: `getServiceToken()`
 * needs BOTH to use the credential path and falls back to attestation
 * otherwise.
 */
function serviceConfiguration(env: NodeJS.ProcessEnv): ClarityServiceConfiguration {
  const baseUrl = canonicalBaseUrl(env);
  const publicKey = env.OXY_SERVICE_API_KEY;
  const expectedClientId = CLARITY_AGENT_MANIFEST.backendApplication.clientId;

  const secret = env.OXY_SERVICE_API_SECRET;
  if (secret !== undefined && secret.trim() !== '') {
    // Credential mode: the pair must be complete AND exactly Clarity's.
    return {
      mode: 'credential',
      publicKey: requireExact(publicKey, expectedClientId, 'OXY_SERVICE_API_KEY'),
      secret,
      baseUrl,
    };
  }

  // Attestation mode. A leftover client id is still pinned; an absent one is fine.
  if (publicKey !== undefined && publicKey !== '') {
    requireExact(publicKey, expectedClientId, 'OXY_SERVICE_API_KEY');
  }
  if (!canAttestWorkloadIdentity(env)) {
    /**
     * Neither a secret nor a workload identity to attest. This is the honest
     * answer on a laptop, and it must stay an error: readiness reports it as
     * `clarity_service_identity_unconfigured` rather than letting the process
     * serve traffic it cannot authenticate.
     */
    throw new ClarityServiceConfigurationError(
      'No Clarity service identity: OXY_SERVICE_API_SECRET is unset and this process cannot attest a workload identity.',
    );
  }
  return { mode: 'attestation', baseUrl };
}

function decodeClaims(token: string): ServiceTokenClaims {
  const payload = token.split('.')[1];
  if (!payload) throw new ClarityServiceConfigurationError('Oxy returned an invalid service token.');
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ServiceTokenClaims;
  } catch {
    throw new ClarityServiceConfigurationError('Oxy returned an invalid service token.');
  }
}

/**
 * The credential identifiers a Clarity service token may carry — and only these.
 *
 * A credential mint names the application credential's own id. An attested mint
 * names the workload's stable attestation handle instead (oxy's
 * `workloadAttestationHandle`), which is a function of the canonical task-role
 * ARN and therefore identical for every task and every deploy. Both name
 * exactly one identity, and that identity is Clarity's; nothing else is
 * accepted. In particular this is NOT "any `wl_` handle" — another service
 * attesting its own role produces a different handle and is refused here.
 */
const ACCEPTED_CREDENTIAL_IDS: readonly string[] = Object.freeze([
  CLARITY_AGENT_MANIFEST.backendApplication.credentialId,
  CLARITY_AGENT_MANIFEST.workloadIdentity.attestationId,
]);

export function assertExactClarityServiceClaims(token: string): void {
  const claims = decodeClaims(token);
  const expected = CLARITY_AGENT_MANIFEST.backendApplication;
  const tokenScopes = Array.isArray(claims.scopes) ? claims.scopes : [];
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    claims.type !== 'service'
    || claims.appId !== expected.applicationId
    || typeof claims.credentialId !== 'string'
    || !ACCEPTED_CREDENTIAL_IDS.includes(claims.credentialId)
    || claims.ownerAccountId !== CLARITY_AGENT_MANIFEST.projectAccountId
    || tokenScopes.length !== expected.scopes.length
    || new Set(tokenScopes).size !== expected.scopes.length
    || expected.scopes.some((scope) => !tokenScopes.includes(scope))
    || typeof claims.exp !== 'number'
    || !Number.isFinite(claims.exp)
    || !Number.isInteger(claims.exp)
    || claims.exp <= nowSeconds + TOKEN_EXPIRY_CLOCK_SKEW_SECONDS
  ) {
    throw new ClarityServiceConfigurationError('Oxy service token claims do not match the canonical Clarity service identity.');
  }
}

export function hasExactClarityServiceConfiguration(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    serviceConfiguration(env);
    return true;
  } catch {
    return false;
  }
}

export async function getClarityServiceToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const config = serviceConfiguration(env);
  /**
   * The fingerprint keys the cached client on the identity it was built for.
   * The mode is part of it: dropping the secret must rebuild the client rather
   * than keep one still configured with a credential.
   */
  const fingerprint = createHash('sha256')
    .update(config.mode === 'credential'
      ? `credential\0${config.baseUrl}\0${config.publicKey}\0${config.secret}`
      : `attestation\0${config.baseUrl}`)
    .digest('hex');
  if (!client || clientFingerprint !== fingerprint) {
    client = new OxyServices({ baseURL: config.baseUrl });
    // Left unconfigured under attestation: `getServiceToken()` takes the
    // workload path precisely when no credential was configured.
    if (config.mode === 'credential') client.configureServiceAuth(config.publicKey, config.secret);
    clientFingerprint = fingerprint;
  }
  const token = await client.getServiceToken();
  assertExactClarityServiceClaims(token);
  return token;
}
