import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const introspect = vi.fn();
vi.mock('../../lib/clarity-service-auth.js', () => ({
  clarityOxyServer: () => ({ introspectResourceToken: introspect }),
}));
vi.mock('../../search/quotas.js', () => ({
  consumeRequestRate: vi.fn(async () => ({ accepted: true })),
}));
import type { ClarityResourcePrincipal } from '../resource-auth.js';
const { authenticateResource, requireResourceScope } = await import('../resource-auth.js');

function response() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res as typeof res & Response;
}
function request(principal?: Partial<ClarityResourcePrincipal>, token = 'token'): Request {
  return {
    resourcePrincipal: principal,
    header: (name: string) => (name === 'authorization' ? `Bearer ${token}` : undefined),
  } as Request;
}
const own = {
  active: true,
  permissions: [],
  kind: 'service',
  authority: 'first_party',
  accountId: 'owner',
  applicationId: 'caller',
  credentialId: 'wl_caller',
  environment: 'production',
  expiresAt: '2099-01-01T00:00:00.000Z',
  audience: 'oxy-service:01a0648b-8d73-70ad-8e67-1c07ddc5eb6e',
} satisfies ClarityResourcePrincipal;
beforeEach(() => {
  introspect.mockReset();
});

describe('live resource authority', () => {
  it.each([own.audience, 'oxy-api'])(
    'accepts explicitly verified own service audience %s',
    async (audience) => {
      introspect.mockResolvedValue({ ...own, audience });
      const req = request(),
        next = vi.fn();
      await authenticateResource(req, response(), next);
      expect(next).toHaveBeenCalledOnce();
      expect(req.resourcePrincipal).toEqual({ ...own, audience });
      requireResourceScope('clarity:index')(req, response(), next as NextFunction);
      expect(next).toHaveBeenCalledTimes(2);
    },
  );
  it('rejects another product audience', async () => {
    introspect.mockResolvedValue({ ...own, audience: 'oxy-service:other' });
    const next = vi.fn(),
      res = response();
    await authenticateResource(request(), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
  it('accepts a shared managed-account session without inventing application or credential', async () => {
    const session = {
      active: true,
      permissions: [],
      kind: 'session',
      authority: 'first_party',
      applicationId: null,
      accountId: 'organization',
      effectiveAccountId: 'organization',
      requesterAccountId: 'person',
      expiresAt: own.expiresAt,
    };
    introspect.mockResolvedValue(session);
    const req = request(),
      next = vi.fn();
    await authenticateResource(req, response(), next);
    expect(req.resourcePrincipal).toEqual(session);
    requireResourceScope('clarity:index')(req, response(), next as NextFunction);
    expect(next).toHaveBeenCalledTimes(2);
  });
  it('keeps an external key scoped without fabricating expiry or audience', async () => {
    const key = {
      active: true,
      permissions: [],
      kind: 'key',
      authority: 'external',
      accountId: 'owner',
      applicationId: 'official-app',
      credentialId: 'key-id',
      environment: 'production',
      scopes: ['clarity:search'],
    };
    introspect.mockResolvedValue(key);
    const req = request(),
      next = vi.fn();
    await authenticateResource(req, response(), next);
    expect(req.resourcePrincipal).toEqual(key);
    const denied = response();
    requireResourceScope('clarity:index')(req, denied, next as NextFunction);
    expect(denied.statusCode).toBe(403);
    expect(next).toHaveBeenCalledOnce();
  });
  it('never treats branding as own authority', () => {
    const req = request({ ...own, authority: 'external', scopes: [] });
    if (!req.resourcePrincipal) throw new Error('Fixture missing principal');
    Object.assign(req.resourcePrincipal, { tier: 'internal' });
    const next = vi.fn(),
      res = response();
    requireResourceScope('clarity:index')(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
  it.each([{ active: false }, { ...own, expiresAt: '2020-01-01T00:00:00.000Z' }])(
    'does not retain authorization after revocation/expiry',
    async (denied) => {
      introspect.mockResolvedValueOnce(own).mockResolvedValueOnce(denied);
      const req = request(),
        first = vi.fn();
      await authenticateResource(req, response(), first);
      expect(first).toHaveBeenCalledOnce();
      const next = vi.fn(),
        res = response();
      await authenticateResource(req, res, next);
      expect(res.statusCode).toBe(401);
      expect(req.resourcePrincipal).toBeUndefined();
      expect(next).not.toHaveBeenCalled();
      expect(introspect).toHaveBeenCalledTimes(2);
    },
  );
  it('fails closed on authority outage without retaining a previous principal', async () => {
    introspect.mockRejectedValue(new Error('unavailable'));
    const req = request(own),
      next = vi.fn(),
      res = response();
    await authenticateResource(req, res, next);
    expect(res.statusCode).toBe(503);
    expect(req.resourcePrincipal).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });
});
