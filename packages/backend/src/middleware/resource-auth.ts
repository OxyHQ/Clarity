import type { NextFunction, Request, Response } from 'express';
import type { ResourcePrincipal } from '@oxy.so/contracts';

import { clarityOxyServer } from '../lib/clarity-service-auth.js';
import { CLARITY_IDENTITY } from '../lib/clarity-identity.js';
import { consumeRequestRate } from '../search/quotas.js';

export type ClarityResourcePrincipal = ResourcePrincipal;
const CLARITY_SERVICE_AUDIENCE = `oxy-service:${CLARITY_IDENTITY.backendApplication.applicationId}`;

/**
 * Temporary receiver-first bridge: Oxy alone may project a live, exact-cohort v1
 * workload as first_party. No tier, app flag, token decoder or local allowlist
 * can confer that authority here. Remove the own oxy-api branch after cutover.
 */
function intendedForClarity(principal: ClarityResourcePrincipal): boolean {
  if (principal.kind !== 'service') return true;
  return principal.authority === 'first_party'
    ? principal.audience === CLARITY_SERVICE_AUDIENCE || principal.audience === 'oxy-api'
    : principal.audience === 'oxy-api';
}

declare global {
  namespace Express {
    interface Request {
      resourcePrincipal?: ClarityResourcePrincipal;
    }
  }
}

function bearerToken(req: Request): string | undefined {
  const authorization = req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const token = authorization.slice('Bearer '.length);
  return token.length > 0 ? token : undefined;
}

export async function authenticateResource(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  delete req.resourcePrincipal;
  const token = bearerToken(req);
  if (!token) {
    sendError(
      res,
      401,
      'authentication_required',
      'A bearer token or oxy_sk credential is required',
      req,
    );
    return;
  }

  try {
    // Revalidate every request: enrollment, owner/credential revocation and
    // scope changes must not outlive a cached positive authorization.
    const principal = await clarityOxyServer().introspectResourceToken(token);
    if (
      !principal.active ||
      !intendedForClarity(principal) ||
      ('expiresAt' in principal && Date.parse(principal.expiresAt) <= Date.now())
    ) {
      sendError(
        res,
        401,
        'invalid_credential',
        'The supplied credential is invalid or inactive',
        req,
      );
      return;
    }
    req.resourcePrincipal = principal;
    next();
  } catch {
    sendError(res, 503, 'identity_unavailable', 'Oxy identity is temporarily unavailable', req);
  }
}

/**
 * The per-credential and per-application request ceiling every credentialed
 * `/v1` surface sits behind. It runs after {@link authenticateResource}, which
 * is what puts the principal the buckets are keyed by on the request.
 */
export async function requireResourceRequestRate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const principal = req.resourcePrincipal;
  if (!principal) return;
  const result = await consumeRequestRate(principal);
  if (!result.accepted) {
    if (result.retryAfterSeconds) res.setHeader('Retry-After', String(result.retryAfterSeconds));
    sendError(res, 429, 'rate_limit_exceeded', 'The request rate limit has been exceeded', req);
    return;
  }
  next();
}

/**
 * A scope an EXTERNAL caller must hold. One of Oxy's own applications passes:
 * inside the ecosystem apps trust each other, and scopes are the third-party lane.
 */
export function requireResourceScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.resourcePrincipal?.authority === 'first_party') {
      next();
      return;
    }
    if (
      req.resourcePrincipal?.authority !== 'external' ||
      !req.resourcePrincipal.scopes.includes(scope)
    ) {
      sendError(res, 403, 'scope_missing', `The ${scope} scope is required`, req);
      return;
    }
    next();
  };
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  req: Request,
  details?: Record<string, unknown>,
): void {
  const requestId = req.header('x-request-id') || crypto.randomUUID();
  res.status(status).json({ error: { code, message, requestId, ...(details ? { details } : {}) } });
}
