/**
 * `mcp.clarity.surf/mcp` over real HTTP: the OAuth challenge, the host check,
 * the protected-resource metadata, which tools are public, and that a call
 * acts as the connection's ACTIVE account.
 *
 * Oxy's introspection is the injected `fetch`; everything after it is the
 * production service, mounted the way `index.ts` mounts it.
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Bun runs this suite too: plain factories, no `vi.hoisted` or `importOriginal`.
const listNotifications = vi.fn();
vi.mock('../../db/notification-repository.js', () => ({ listNotifications }));
vi.mock('../../lib/notification-service.js', () => ({
  getUnreadCount: vi.fn(async () => 2),
  markAsRead: vi.fn(),
  markAllAsRead: vi.fn(),
  dismissNotification: vi.fn(),
}));

const { CLARITY_CAPABILITY_CATALOG } = await import('../clarity.catalog.js');
const { createClarityMcpHttpService } = await import('../clarity-mcp-http.js');
const { createClarityInternalMcpReceiver } = await import('../clarity-internal-mcp.js');
const { mountCapabilityLanes } = await import('../mount.js');
const { listen, send } = await import('./http.js');

const RESOURCE = 'https://mcp.clarity.surf';
const HOST = 'mcp.clarity.surf';
const ISSUER = 'https://api.oxy.so';

/** The token Oxy answers for, and the connection it belongs to. */
let introspected: Record<string, unknown> | null = null;

const fetchStub = (async (input: string | URL | Request) => {
  const url = String(input);
  if (!url.endsWith('/auth/mcp/oauth/introspect')) throw new Error(`unexpected fetch ${url}`);
  return new Response(JSON.stringify(introspected ?? { active: false }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

function liveToken(account: string, connection?: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const scopes = [
    ...new Set(
      CLARITY_CAPABILITY_CATALOG.tools
        .filter((tool) => tool.exposure.includes('mcp'))
        .flatMap((tool) => tool.requiredCapabilities),
    ),
  ];
  introspected = {
    active: true,
    iss: ISSUER,
    sub: account,
    aud: CLARITY_CAPABILITY_CATALOG.audience,
    resource: RESOURCE,
    client_id: 'claude',
    scope: scopes.join(' '),
    jti: randomUUID(),
    iat: now,
    exp: now + 600,
    account_id: account,
    ...(connection ? { connection } : {}),
  };
}

let port = 0;
let close: () => Promise<void>;

beforeAll(async () => {
  const app = express();
  mountCapabilityLanes(app, {
    internal: createClarityInternalMcpReceiver({
      register: async () => {
        throw new Error('not under test');
      },
      verifyTicket: async () => {
        throw new Error('not under test');
      },
      audit: async () => undefined,
    }),
    external: createClarityMcpHttpService({
      authorizationServer: ISSUER,
      fetch: fetchStub,
      getServiceToken: async () => 'service-token',
    }),
  });
  // Anything a later middleware would do must never be reached by MCP.
  app.use(express.json());
  ({ port, close } = await listen(app));
});
afterAll(() => close());
beforeEach(() => {
  introspected = null;
  listNotifications.mockReset();
});

const mcp = (method: string, params: Record<string, unknown>, host = HOST, token = true) =>
  send(port, {
    path: '/mcp',
    host,
    headers: {
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: 'Bearer opaque-token' } : {}),
    },
    body: { jsonrpc: '2.0', id: 1, method, params },
  });

describe('mcp.clarity.surf/mcp', () => {
  it('answers 401 with the protected-resource metadata URL when there is no token', async () => {
    const res = await mcp('tools/list', {}, HOST, false);
    expect(res.status).toBe(401);
    expect(String(res.headers['www-authenticate'])).toContain(
      `resource_metadata="${RESOURCE}/.well-known/oauth-protected-resource"`,
    );
  });

  it('answers 401 for a token Oxy reports inactive', async () => {
    expect((await mcp('tools/list', {})).status).toBe(401);
  });

  it('answers 421 when the request reaches another host, such as the API', async () => {
    liveToken(randomUUID());
    expect((await mcp('tools/list', {}, 'api.clarity.surf')).status).toBe(421);
  });

  it('serves its protected-resource metadata, naming Oxy as the authorization server', async () => {
    const res = await send(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource',
      host: HOST,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ resource: RESOURCE, authorization_servers: [ISSUER] });
  });

  it('lists the public tools and never a feature gate', async () => {
    liveToken(randomUUID());
    const res = await mcp('tools/list', {});
    const names = (res.body as { result: { tools: { name: string }[] } }).result.tools.map(
      (tool) => tool.name,
    );
    expect(names).toContain('search');
    expect(names).toContain('searchJobs');
    expect(names).toContain('addExperience');
    expect(names.filter((name) => name.startsWith('check'))).toEqual([]);
  });

  it('acts as the connection’s active account, never one in the input', async () => {
    const account = randomUUID();
    liveToken(account);
    listNotifications.mockResolvedValue({ rows: [], total: 0 });
    const res = await mcp('tools/call', { name: 'listMyNotifications', arguments: {} });
    expect(
      (res.body as { result: { structuredContent: unknown } }).result.structuredContent,
    ).toEqual({ notifications: [], total: 0, unreadCount: 2 });
    expect(listNotifications).toHaveBeenCalledWith(expect.objectContaining({ oxyUserId: account }));
  });
});
