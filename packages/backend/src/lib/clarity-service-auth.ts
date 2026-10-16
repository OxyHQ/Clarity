import { createHash } from 'node:crypto';
import {
  canAttestWorkloadIdentity,
  OxyServer,
  type ServiceTokenAudience,
} from '@oxy.so/core/server';

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

let client: OxyServer | undefined;
let clientFingerprint = '';
const CANONICAL_OXY_API_URL = 'https://api.oxy.so';

/**
 * How this process authenticates to Oxy: by attestation, and only by
 * attestation (oxy ADR 0026). The task signs an STS `GetCallerIdentity` request
 * with its ECS task role and Oxy mints the service token from it. There is no
 * key pair: the backend credential `01a0648b-8d74-7240-adba-80707fdfdf9c` and
 * its `/oxy/clarity/OXY_SERVICE_API_*` pair are retired.
 */
interface ClarityServiceConfiguration {
  baseUrl: string;
}

function requireExact(value: string | undefined, expected: string, name: string): string {
  if (value !== expected)
    throw new ClarityServiceConfigurationError(
      `${name} does not match the canonical Clarity identity.`,
    );
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
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/'
  ) {
    throw new ClarityServiceConfigurationError('OXY_API_URL must be a plain origin.');
  }
  if (env.NODE_ENV === 'production' && parsed.origin !== CANONICAL_OXY_API_URL) {
    throw new ClarityServiceConfigurationError(
      'Production OXY_API_URL must use the canonical Oxy origin.',
    );
  }
  return parsed.origin;
}

/**
 * Which identity this process may present, and on what evidence.
 *
 * The evidence is the task role, and the identity is asserted where it is
 * PROVABLE: {@link assertExactClarityServiceClaims} reads the token Oxy just
 * returned and refuses anything whose app, payer, credential and scope set are
 * not exactly Clarity's.
 *
 * ## The retired key pair
 *
 * `OXY_SERVICE_API_SECRET` used to select a credential mode. The credential it
 * authenticated is revoked, so that mode could only ever fail — and a secret
 * still reaching this process means something is still injecting a retired
 * credential. It is refused outright rather than ignored, so the deployment
 * that carries it is the thing that fails readiness, loudly, instead of the pair
 * quietly surviving in a task definition.
 *
 * A leftover `OXY_SERVICE_API_KEY` is only a public id, but it is still pinned:
 * a FOREIGN client id in the environment is a deployment error worth refusing
 * even when nothing reads it.
 */
function serviceConfiguration(env: NodeJS.ProcessEnv): ClarityServiceConfiguration {
  const baseUrl = canonicalBaseUrl(env);
  const secret = env.OXY_SERVICE_API_SECRET;
  if (secret !== undefined && secret.trim() !== '') {
    throw new ClarityServiceConfigurationError(
      'OXY_SERVICE_API_SECRET is retired: Clarity authenticates only by attesting its task role.',
    );
  }
  const publicKey = env.OXY_SERVICE_API_KEY;
  if (publicKey !== undefined && publicKey !== '') {
    requireExact(
      publicKey,
      CLARITY_AGENT_MANIFEST.backendApplication.clientId,
      'OXY_SERVICE_API_KEY',
    );
  }
  if (!canAttestWorkloadIdentity(env)) {
    /**
     * Nothing to attest. This is the honest answer on a laptop, and it must
     * stay an error: readiness reports it as
     * `clarity_service_identity_unconfigured` rather than letting the process
     * serve traffic it cannot authenticate.
     */
    throw new ClarityServiceConfigurationError(
      'No Clarity service identity: this process cannot attest a workload identity.',
    );
  }
  return { baseUrl };
}

function decodeClaims(token: string): ServiceTokenClaims {
  const payload = token.split('.')[1];
  if (!payload)
    throw new ClarityServiceConfigurationError('Oxy returned an invalid service token.');
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ServiceTokenClaims;
  } catch {
    throw new ClarityServiceConfigurationError('Oxy returned an invalid service token.');
  }
}

/**
 * The one credential identifier a Clarity service token may carry: the
 * workload's stable attestation handle (oxy's `workloadAttestationHandle`), a
 * function of the canonical task-role ARN and therefore identical for every
 * task and every deploy. This is NOT "any `wl_` handle" — another service
 * attesting its own role produces a different handle and is refused here — and
 * it is no longer the retired backend credential's id either.
 */
const ACCEPTED_CREDENTIAL_IDS: readonly string[] = Object.freeze([
  CLARITY_AGENT_MANIFEST.workloadIdentity.attestationId,
]);

export function assertExactClarityServiceClaims(token: string): void {
  const claims = decodeClaims(token);
  const expected = CLARITY_AGENT_MANIFEST.backendApplication;
  const tokenScopes = Array.isArray(claims.scopes) ? claims.scopes : [];
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    claims.type !== 'service' ||
    claims.appId !== expected.applicationId ||
    typeof claims.credentialId !== 'string' ||
    !ACCEPTED_CREDENTIAL_IDS.includes(claims.credentialId) ||
    claims.ownerAccountId !== CLARITY_AGENT_MANIFEST.projectAccountId ||
    tokenScopes.length !== expected.scopes.length ||
    new Set(tokenScopes).size !== expected.scopes.length ||
    expected.scopes.some((scope) => !tokenScopes.includes(scope)) ||
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.exp) ||
    !Number.isInteger(claims.exp) ||
    claims.exp <= nowSeconds + TOKEN_EXPIRY_CLOCK_SKEW_SECONDS
  ) {
    throw new ClarityServiceConfigurationError(
      'Oxy service token claims do not match the canonical Clarity service identity.',
    );
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

function clarityServiceClient(env: NodeJS.ProcessEnv): OxyServer {
  const config = serviceConfiguration(env);
  /** The fingerprint keys the cached client on the origin it was built for. */
  const fingerprint = createHash('sha256').update(`attestation\0${config.baseUrl}`).digest('hex');
  if (!client || clientFingerprint !== fingerprint) {
    // Never given a credential: `serviceToken()` takes the workload path
    // precisely because none is configured.
    client = new OxyServer({ baseURL: config.baseUrl });
    clientFingerprint = fingerprint;
  }
  return client;
}

export async function getClarityServiceToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  // The workload may gain unrelated product scopes; Alia still receives exactly this manifest tuple.
  const token = await clarityServiceClient(env).serviceToken(undefined, undefined, {
    scopes: [...CLARITY_AGENT_MANIFEST.backendApplication.scopes],
  });
  assertExactClarityServiceClaims(token);
  return token;
}

/**
 * Clarity's service token for another resource server: `kaana.ai` is the
 * credential `https://kaana.ai/v1` accepts (Kaana ADR 0002, decision 6). The
 * same attested identity and the same exact claims as
 * {@link getClarityServiceToken}, minted for its own audience and cached apart
 * by `OxyServer`, so an `oxy-api` token never reaches Kaana nor the reverse.
 */
export async function getClarityServiceTokenFor(
  audience: ServiceTokenAudience,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const token = await clarityServiceClient(env).serviceTokenFor(audience, undefined, undefined, {
    scopes: [...CLARITY_AGENT_MANIFEST.backendApplication.scopes],
  });
  assertExactClarityServiceClaims(token);
  return token;
}
