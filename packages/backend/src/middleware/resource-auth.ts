import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { getClarityServiceToken } from '../lib/clarity-service-auth.js';
import { consumeRequestRate } from '../search/quotas.js';

const activeIntrospectionSchema = z.object({
  active: z.literal(true),
  accountId: z.string().min(1),
  applicationId: z.string().min(1),
  credentialId: z.string().min(1).optional(),
  environment: z.string().min(1),
  delegatedUserId: z.string().min(1).optional(),
  /**
   * `internal` when the caller is one of Oxy's own applications, which uses
   * Clarity with no scope and no quota; anything else — third-party apps,
   * `oxy_sk` keys — is `external`. Oxy answers it; an answer without it (an
   * older Oxy) reads as external, the conservative side.
   */
  tier: z.enum(['internal', 'external']).catch('external').default('external'),
  scopes: z.array(z.string()),
  permissions: z.array(z.string()),
  expiresAt: z.string().datetime().optional(),
});

const introspectionSchema = z.discriminatedUnion('active', [
  activeIntrospectionSchema,
  z.object({ active: z.literal(false) }),
]);
export type ClarityResourcePrincipal = z.infer<typeof activeIntrospectionSchema>;

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
    const serviceToken = await getClarityServiceToken();
    const baseUrl = process.env.OXY_API_URL || 'https://api.oxy.so';
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/auth/resources/introspect`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        sendError(
          res,
          401,
          'invalid_credential',
          'The supplied credential is invalid or inactive',
          req,
        );
        return;
      }
      sendError(res, 503, 'identity_unavailable', 'Oxy identity is temporarily unavailable', req);
      return;
    }
    const principal = introspectionSchema.parse(await response.json());
    if (
      !principal.active ||
      (principal.expiresAt && Date.parse(principal.expiresAt) <= Date.now())
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
    if (req.resourcePrincipal?.tier === 'internal') {
      next();
      return;
    }
    if (!req.resourcePrincipal?.scopes.includes(scope)) {
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
