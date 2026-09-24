import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/clarity-service-auth.js', () => ({ getClarityServiceToken: vi.fn(async () => 'clarity-service-token') }));
vi.mock('../../search/quotas.js', () => ({ consumeRequestRate: vi.fn(async () => ({ accepted: true })) }));

import { authenticateResource, requireResourceScope, type ClarityResourcePrincipal } from '../resource-auth.js';

interface FakeResponse {
  statusCode: number;
  body: unknown;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  setHeader(): FakeResponse;
}

function response(): FakeResponse & Response {
  const res: FakeResponse = {
    statusCode: 200,
    body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
    setHeader() { return res; },
  };
  return res as FakeResponse & Response;
}

/** A `next` the middleware can call, and the test can count. */
function nextSpy() {
  const spy = vi.fn();
  return Object.assign(spy as unknown as NextFunction, { spy });
}

function request(principal?: Partial<ClarityResourcePrincipal>, bearer?: string): Request {
  const headers: Record<string, string> = bearer ? { authorization: `Bearer ${bearer}` } : {};
  return { resourcePrincipal: principal, header: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
}

describe('requireResourceScope', () => {
  it("passes one of Oxy's own applications whatever scope is asked for", () => {
    const next = nextSpy();
    requireResourceScope('clarity:index')(request({ tier: 'internal', scopes: [] }), response(), next);
    expect(next.spy).toHaveBeenCalledTimes(1);
  });

  it('holds an external caller to its scopes', () => {
    const next = nextSpy();
    const res = response();
    requireResourceScope('clarity:index')(request({ tier: 'external', scopes: ['clarity:search'] }), res, next);
    expect(next.spy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);

    requireResourceScope('clarity:search')(request({ tier: 'external', scopes: ['clarity:search'] }), response(), next);
    expect(next.spy).toHaveBeenCalledTimes(1);
  });
});

describe('authenticateResource reads the tier Oxy answers', () => {
  const upstream = vi.fn<typeof fetch>();
  const introspection = { active: true, accountId: 'a', applicationId: 'app', environment: 'production', scopes: [], permissions: [] };

  beforeEach(() => {
    process.env.CLARITY_INTROSPECTION_CACHE_HMAC_KEY = 'test-hmac-key';
    upstream.mockReset();
    vi.stubGlobal('fetch', upstream);
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['internal', { tier: 'internal' }, 'internal'],
    ['absent (an older Oxy)', {}, 'external'],
    ['unknown', { tier: 'staff' }, 'external'],
  ])('tier %s → %s', async (_label, extra, expected) => {
    upstream.mockResolvedValue(new Response(JSON.stringify({ ...introspection, ...extra }), { status: 200 }));
    const req = request(undefined, `token-${expected}-${Math.random()}`);
    const next = nextSpy();

    await authenticateResource(req, response(), next);

    expect(next.spy).toHaveBeenCalledTimes(1);
    expect(req.resourcePrincipal?.tier).toBe(expected);
  });
});
