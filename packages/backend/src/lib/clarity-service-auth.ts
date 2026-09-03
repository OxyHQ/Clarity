import { createHash } from 'node:crypto';
import { OxyServices } from '@oxyhq/core';

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

function requireExact(value: string | undefined, expected: string, name: string): string {
  if (value !== expected) throw new ClarityServiceConfigurationError(`${name} does not match the canonical Clarity identity.`);
  return value;
}

function serviceConfiguration(env: NodeJS.ProcessEnv) {
  const publicKey = requireExact(
    env.OXY_SERVICE_API_KEY,
    CLARITY_AGENT_MANIFEST.backendApplication.clientId,
    'OXY_SERVICE_API_KEY',
  );
  const secret = env.OXY_SERVICE_API_SECRET;
  if (!secret || secret.trim() === '') {
    throw new ClarityServiceConfigurationError('OXY_SERVICE_API_SECRET is not configured.');
  }
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
  return { publicKey, secret, baseUrl: parsed.origin };
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

export function assertExactClarityServiceClaims(token: string): void {
  const claims = decodeClaims(token);
  const expected = CLARITY_AGENT_MANIFEST.backendApplication;
  const tokenScopes = Array.isArray(claims.scopes) ? claims.scopes : [];
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    claims.type !== 'service'
    || claims.appId !== expected.applicationId
    || claims.credentialId !== expected.credentialId
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
  const { publicKey, secret, baseUrl } = serviceConfiguration(env);
  const fingerprint = createHash('sha256').update(`${baseUrl}\0${publicKey}\0${secret}`).digest('hex');
  if (!client || clientFingerprint !== fingerprint) {
    client = new OxyServices({ baseURL: baseUrl });
    client.configureServiceAuth(publicKey, secret);
    clientFingerprint = fingerprint;
  }
  const token = await client.getServiceToken();
  assertExactClarityServiceClaims(token);
  return token;
}
