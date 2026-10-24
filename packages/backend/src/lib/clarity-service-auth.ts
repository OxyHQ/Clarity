import { createHash } from 'node:crypto';
import { OxyServer, type ServiceTokenAudience } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';

import { CLARITY_IDENTITY } from './clarity-identity.js';

export class ClarityServiceConfigurationError extends Error {}

interface ServiceTokenClaims {
  type?: unknown;
  appId?: unknown;
  credentialId?: unknown;
  ownerAccountId?: unknown;
  authority?: unknown;
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

/** The Oxy API origin this process talks to: `OXY_API_URL`, and only the canonical one in production. */
export function canonicalBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
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
 * returned and refuses anything whose app, payer and credential are not exactly
 * Clarity's. Scopes never establish the authority of an own workload.
 *
 * ## The retired key pair
 *
 * `OXY_SERVICE_API_KEY` and `OXY_SERVICE_API_SECRET` used to select a
 * credential mode. The credential they authenticated is revoked, so that mode
 * could only ever fail — and either variable still reaching this process means
 * something is still injecting a retired credential. Both are refused outright
 * rather than ignored, so the deployment that carries one is the thing that
 * fails readiness, loudly, instead of the pair quietly surviving in a task
 * definition. The deploy strips both from every revision it renders
 * (`TASK_CONFIGURATION_REMOVALS_JSON` in deploy-aws.yml).
 */
function serviceConfiguration(env: NodeJS.ProcessEnv): ClarityServiceConfiguration {
  const baseUrl = canonicalBaseUrl(env);
  for (const name of ['OXY_SERVICE_API_KEY', 'OXY_SERVICE_API_SECRET'] as const) {
    const value = env[name];
    if (value !== undefined && value.trim() !== '') {
      throw new ClarityServiceConfigurationError(
        `${name} is retired: Clarity authenticates only by attesting its task role.`,
      );
    }
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
  CLARITY_IDENTITY.workloadIdentity.attestationId,
]);

export function assertExactClarityServiceClaims(token: string): void {
  const claims = decodeClaims(token);
  const expected = CLARITY_IDENTITY.backendApplication;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    claims.type !== 'service' ||
    claims.appId !== expected.applicationId ||
    typeof claims.credentialId !== 'string' ||
    !ACCEPTED_CREDENTIAL_IDS.includes(claims.credentialId) ||
    claims.ownerAccountId !== CLARITY_IDENTITY.projectAccountId ||
    (claims.authority !== undefined && claims.authority !== 'first_party') ||
    (claims.authority === 'first_party' && claims.scopes !== undefined) ||
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
    client = new OxyServer({
      baseURL: config.baseUrl,
      workloadCredentials: createAwsWorkloadCredentialProvider(),
    });
    clientFingerprint = fingerprint;
  }
  return client;
}

/** Application-owned files use this workload; the application remains the owner. */
export function getClarityFilesClient(env: NodeJS.ProcessEnv = process.env): OxyServer {
  return clarityServiceClient(env);
}

export async function getClarityServiceToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const token = await clarityServiceClient(env).serviceToken();
  assertExactClarityServiceClaims(token);
  return token;
}

/**
 * The attested Oxy client itself, for the calls that authenticate as Clarity
 * through it rather than with a bare token: live capability-ticket
 * introspection (`capabilities/capability-authority.ts`).
 */
export function clarityOxyServer(env: NodeJS.ProcessEnv = process.env): OxyServer {
  return clarityServiceClient(env);
}

/** Forget the cached service token(s) after Oxy refused one, so the next call mints anew. */
export function invalidateClarityServiceToken(env: NodeJS.ProcessEnv = process.env): void {
  clarityServiceClient(env).invalidateServiceToken();
}

/**
 * Clarity's service token for another resource server: `kaana.ai` is the
 * credential `https://kaana.ai/v1` accepts (Kaana ADR 0002, decision 6). The
 * same attested identity as
 * {@link getClarityServiceToken}, minted for its own audience and cached apart
 * by `OxyServer`, so an `oxy-api` token never reaches Kaana nor the reverse.
 */
export async function getClarityServiceTokenFor(
  audience: ServiceTokenAudience,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const token = await clarityServiceClient(env).serviceTokenFor(audience);
  assertExactClarityServiceClaims(token);
  return token;
}
