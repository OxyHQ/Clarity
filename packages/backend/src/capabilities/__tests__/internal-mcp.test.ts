/**
 * `/_oxy/mcp` over real HTTP: what it refuses, and that what it admits acts as
 * the ticket's effective account and is audited.
 *
 * Tickets are signed here with a throwaway Ed25519 key through the same
 * `issueCapabilityTicket` Oxy uses, and verified by the production
 * `createTicketVerifier` with that key and a stubbed live introspection, so
 * every refusal below goes through the code that runs in ECS. The tools'
 * domain is stubbed (`handlers`): this suite is about the lane, the handlers'
 * own suites are about what they do.
 */
import { generateKeyPairSync, type KeyObject, randomUUID } from 'node:crypto';
import type { CapabilityCatalogBinding } from '@oxy.so/contracts';
import { issueCapabilityTicket } from '@oxy.so/core/server';
import { capabilityCatalogDigest } from '@oxy.so/mcp';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type CapabilityAuditInput, createTicketVerifier } from '../capability-authority.js';
import { CLARITY_CAPABILITY_CATALOG } from '../clarity.catalog.js';
import { buildClarityInvocationHandlers } from '../clarity.handlers.js';
import {
  createClarityInternalMcp,
  createClarityInternalMcpReceiver,
} from '../clarity-internal-mcp.js';
import type { ClarityToolHandlers } from '../handlers/context.js';
import { listen, rpc } from './http.js';

const ISSUER = 'https://api.oxy.so';
const HOST = 'api.clarity.surf';
const KEY_ID = 'test-key';
const catalog = CLARITY_CAPABILITY_CATALOG;
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

const binding: CapabilityCatalogBinding = {
  registrationId: 'reg-clarity-test',
  version: catalog.version,
  digest: capabilityCatalogDigest(catalog),
};

let introspection: 'allow' | 'deny' = 'allow';
const audits: CapabilityAuditInput[] = [];
const calls: { tool: string; accountId: string }[] = [];

/** Every tool answers who it ran as; nothing reaches a database. */
const stubHandlers: ClarityToolHandlers = Object.fromEntries(
  catalog.tools.map((tool) => [
    tool.name,
    async (_input: unknown, context: { accountId: string }) => {
      calls.push({ tool: tool.name, accountId: context.accountId });
      return { ranAs: context.accountId };
    },
  ]),
);

function verifierFor(key: KeyObject = publicKey) {
  return createTicketVerifier({
    issuer: ISSUER,
    audience: catalog.audience,
    resolveKey: async (kid) => (kid === KEY_ID ? key : undefined),
    // The live check answers from Oxy's own state; here, from the test's.
    introspect: async (ticket) => {
      const claims = JSON.parse(Buffer.from(ticket.split('.')[1] ?? '', 'base64url').toString());
      return introspection === 'allow'
        ? { active: true, claims, decision: { allowed: true, reason: 'ceiling' } }
        : { active: true, claims, decision: { allowed: false, reason: 'revoked' } };
    },
  } as Parameters<typeof createTicketVerifier>[0]);
}

function appWith(key: KeyObject = publicKey) {
  const internal = createClarityInternalMcp({
    binding,
    verifyTicket: verifierFor(key),
    audit: async (input) => {
      audits.push(input);
    },
    handlers: buildClarityInvocationHandlers(catalog.tools, stubHandlers),
  });
  const app = express();
  app.all(internal.mcpPath, (req, res) => {
    void internal.handleMcp(req, res);
  });
  return app;
}

interface TicketOverrides {
  tool?: string;
  audience?: string;
  resourceId?: string;
  ttlSeconds?: number;
  now?: Date;
  catalog?: CapabilityCatalogBinding;
}

function ticketFor(account: string, overrides: TicketOverrides = {}): string {
  const tool = overrides.tool ?? 'listMyNotifications';
  const catalogTool = catalog.tools.find((entry) => entry.name === tool);
  return issueCapabilityTicket(
    {
      aud: overrides.audience ?? catalog.audience,
      sub: 'agent-clarity',
      runId: 'run-1',
      executionAuthorization: { kind: 'direct_request', id: 'ea-1' },
      coordinator: { applicationId: 'alia', credentialId: 'alia-cred' },
      catalog: overrides.catalog ?? binding,
      requesterAccountId: account,
      ownerAccountId: account,
      actor: { type: 'agent', accountId: 'agent-clarity' },
      resource: {
        appId: 'clarity',
        effectiveAccountId: account,
        resourceType: 'clarity_account',
        resourceId: overrides.resourceId ?? account,
      },
      tool,
      capabilities: catalogTool?.requiredCapabilities ?? ['x'],
      limits: [],
      autonomy: 'execute_on_request',
    } as Parameters<typeof issueCapabilityTicket>[0],
    {
      privateKey,
      keyId: KEY_ID,
      issuer: ISSUER,
      ttlSeconds: overrides.ttlSeconds ?? 120,
      ...(overrides.now ? { now: overrides.now } : {}),
    },
  );
}

let port = 0;
let close: () => Promise<void>;
let otherKeyPort = 0;
let closeOther: () => Promise<void>;

beforeAll(async () => {
  ({ port, close } = await listen(appWith()));
  ({ port: otherKeyPort, close: closeOther } = await listen(
    appWith(generateKeyPairSync('ed25519').publicKey),
  ));
});
afterAll(async () => {
  await close();
  await closeOther();
});
beforeEach(() => {
  introspection = 'allow';
  audits.length = 0;
  calls.length = 0;
});

const call = (ticket: string | undefined, name: string, headers: Record<string, string> = {}) =>
  rpc(
    port,
    HOST,
    'tools/call',
    { name, arguments: {} },
    { ...(ticket ? { authorization: `Capability ${ticket}` } : {}), ...headers },
  );

describe('/_oxy/mcp refuses', () => {
  it('a request without a capability ticket (401)', async () => {
    expect((await call(undefined, 'listMyNotifications')).status).toBe(401);
  });

  it('a request sent to another host, such as the public MCP (421)', async () => {
    const res = await rpc(
      port,
      'mcp.clarity.surf',
      'tools/list',
      {},
      {
        authorization: `Capability ${ticketFor(randomUUID())}`,
      },
    );
    expect(res.status).toBe(421);
  });

  it('a ticket issued for another audience', async () => {
    const res = await call(
      ticketFor(randomUUID(), { audience: 'oxy-homiio-api' }),
      'listMyNotifications',
    );
    expect(res.status).toBe(403);
  });

  it('an expired ticket', async () => {
    const ticket = ticketFor(randomUUID(), {
      now: new Date(Date.now() - 10 * 60 * 1000),
      ttlSeconds: 60,
    });
    expect((await call(ticket, 'listMyNotifications')).status).toBe(403);
  });

  it('a ticket Oxy no longer stands behind (live introspection)', async () => {
    introspection = 'deny';
    expect((await call(ticketFor(randomUUID()), 'listMyNotifications')).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('a ticket bound to another catalogue registration', async () => {
    const ticket = ticketFor(randomUUID(), { catalog: { ...binding, digest: 'f'.repeat(64) } });
    expect((await call(ticket, 'listMyNotifications')).status).toBe(403);
  });

  it('a ticket signed by a key Oxy does not publish', async () => {
    const res = await rpc(
      otherKeyPort,
      HOST,
      'tools/call',
      { name: 'listMyNotifications', arguments: {} },
      {
        authorization: `Capability ${ticketFor(randomUUID())}`,
      },
    );
    expect(res.status).toBe(403);
  });

  it('a ticket whose resource is not the account root of its effective account', async () => {
    const res = await call(
      ticketFor(randomUUID(), { resourceId: randomUUID() }),
      'listMyNotifications',
    );
    expect((res.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('a tool the ticket was not issued for', async () => {
    const res = await call(
      ticketFor(randomUUID(), { tool: 'listMyNotifications' }),
      'dismissNotification',
    );
    expect((res.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('/_oxy/mcp admits', () => {
  it('a live ticket, runs the tool as the ticket’s effective account and audits it', async () => {
    const account = randomUUID();
    const res = await call(ticketFor(account), 'listMyNotifications');
    expect(res.status).toBe(200);
    const result = (res.body as { result: { structuredContent: unknown } }).result;
    expect(result.structuredContent).toEqual({ ranAs: account });
    expect(calls).toEqual([{ tool: 'listMyNotifications', accountId: account }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.result).toEqual({ status: 'succeeded' });
  });

  it('a feature gate’s check tool, which only this lane serves', async () => {
    const account = randomUUID();
    const res = await call(ticketFor(account, { tool: 'checkDeepResearch' }), 'checkDeepResearch');
    expect(
      (res.body as { result: { structuredContent: unknown } }).result.structuredContent,
    ).toEqual({
      ranAs: account,
    });
  });
});

describe('the registration the lane binds to', () => {
  it('answers 503 until the catalogue registers, then retries after the back-off', async () => {
    let now = 1_000;
    let attempts = 0;
    const receiver = createClarityInternalMcpReceiver({
      register: async () => {
        attempts += 1;
        throw new Error('oxy down');
      },
      verifyTicket: verifierFor(),
      audit: async () => undefined,
      now: () => now,
    });
    const app = express();
    app.all(receiver.path, (req, res) => {
      void receiver.handle(req, res);
    });
    const server = await listen(app);
    try {
      const first = await rpc(server.port, HOST, 'tools/list', {});
      expect(first.status).toBe(503);
      expect(first.headers['retry-after']).toBe('30');
      await rpc(server.port, HOST, 'tools/list', {});
      expect(attempts).toBe(1);
      now += 30_001;
      await rpc(server.port, HOST, 'tools/list', {});
      expect(attempts).toBe(2);
    } finally {
      await server.close();
    }
  });
});
