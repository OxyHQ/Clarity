import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreFetch, stubFetch } from '../../__tests__/support/global-fetch.js';

vi.mock('../../lib/clarity-service-auth.js', () => ({
  getClarityServiceToken: vi.fn(async () => 'clarity-service-token'),
}));
vi.mock('../../search/quotas.js', () => ({
  consumeRequestRate: vi.fn(async () => ({ accepted: true })),
}));

import {
  authenticateResource,
  requireResourceScope,
  type ClarityResourcePrincipal,
} from '../resource-auth.js';

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
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
    setHeader() {
      return res;
    },
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
  return {
    resourcePrincipal: principal,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

describe('requireResourceScope', () => {
  it("passes one of Oxy's own applications whatever scope is asked for", () => {
    const next = nextSpy();
    requireResourceScope('clarity:index')(
      request({ tier: 'internal', scopes: [] }),
      response(),
      next,
    );
    expect(next.spy).toHaveBeenCalledTimes(1);
  });

  it('holds an external caller to its scopes', () => {
    const next = nextSpy();
    const res = response();
    requireResourceScope('clarity:index')(
      request({ tier: 'external', scopes: ['clarity:search'] }),
      res,
      next,
    );
    expect(next.spy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);

    requireResourceScope('clarity:search')(
      request({ tier: 'external', scopes: ['clarity:search'] }),
      response(),
      next,
    );
    expect(next.spy).toHaveBeenCalledTimes(1);
  });
});

describe('authenticateResource reads the tier Oxy answers', () => {
  const upstream = vi.fn<typeof fetch>();
  const introspection = {
    active: true,
    accountId: 'a',
    applicationId: 'app',
    environment: 'production',
    scopes: [],
    permissions: [],
  };

  beforeEach(() => {
    upstream.mockReset();
    stubFetch(upstream);
  });

  afterEach(() => restoreFetch());

  it.each([
    ['internal', { tier: 'internal' }, 'internal'],
    ['absent (an older Oxy)', {}, 'external'],
    ['unknown', { tier: 'staff' }, 'external'],
  ])('tier %s → %s', async (_label, extra, expected) => {
    upstream.mockResolvedValue(
      new Response(JSON.stringify({ ...introspection, ...extra }), { status: 200 }),
    );
    const req = request(undefined, `token-${expected}-${Math.random()}`);
    const next = nextSpy();

    await authenticateResource(req, response(), next);

    expect(next.spy).toHaveBeenCalledTimes(1);
    expect(req.resourcePrincipal?.tier).toBe(expected);
  });
  it.each(['user-session', 'oxy_sk_existing', 'service-owner-token'])(
    'revalidates %s after enrollment/revocation and never serves a warm authorization',
    async (token) => {
      upstream.mockResolvedValueOnce(
        new Response(JSON.stringify({ ...introspection, tier: 'internal' }), { status: 200 }),
      );
      const first = nextSpy();
      await authenticateResource(request(undefined, token), response(), first);
      expect(first.spy).toHaveBeenCalledTimes(1);
      upstream.mockResolvedValueOnce(
        new Response(JSON.stringify({ active: false, scopes: [], permissions: [] }), {
          status: 200,
        }),
      );
      const second = nextSpy(),
        denied = response();
      await authenticateResource(request(undefined, token), denied, second);
      expect(second.spy).not.toHaveBeenCalled();
      expect(denied.statusCode).toBe(401);
      expect(upstream).toHaveBeenCalledTimes(2);
    },
  );
  it('does not retain a prior authorization during an introspection outage', async () => {
    upstream.mockResolvedValueOnce(new Response(JSON.stringify(introspection), { status: 200 }));
    await authenticateResource(request(undefined, 'same-token'), response(), nextSpy());
    upstream.mockRejectedValueOnce(new Error('Oxy unavailable'));
    const next = nextSpy(),
      denied = response();
    await authenticateResource(request(undefined, 'same-token'), denied, next);
    expect(denied.statusCode).toBe(503);
    expect(next.spy).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
