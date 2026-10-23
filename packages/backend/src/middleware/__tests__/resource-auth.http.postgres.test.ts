import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OxyServices } from '@oxy.so/core';
import { OxyServer } from '@oxy.so/core/server';
import { ClarityClient } from '../../../../sdk/src/client.js';
import { clarityForOxySession } from '../../../../sdk/src/linked.js';
import {
  clarityForOxyService,
  CLARITY_SERVICE_APPLICATION_ID,
} from '../../../../sdk/src/server.js';
import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { crawlJobs, searchRateLimitBuckets } from '../../db/schema/index.js';

const identity = vi.hoisted(() => ({ receiver: undefined as OxyServer | undefined }));
vi.mock('../../lib/clarity-service-auth.js', () => ({
  clarityOxyServer: () => {
    if (!identity.receiver) throw new Error('Fixture receiver not initialized');
    return identity.receiver;
  },
  getClarityServiceToken: async () => 'unused-route-token',
}));
const { default: router } = await import('../../routes/v1/search-platform.js');
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;
const prefix = `authority-http-${crypto.randomUUID()}`;
const ownerA = `${prefix}-a`,
  ownerB = `${prefix}-b`,
  org = `${prefix}-org`;
const applicationId = `${prefix}-app`;
const expiry = '2099-01-01T00:00:00.000Z';
const principals = new Map<string, Record<string, unknown>>();
let oxyHttp: Server, productHttp: Server, oxyUrl: string, productUrl: string;
let caller: OxyServer, sessions: OxyServices;
let own: ClarityClient, personal: ClarityClient;
let liveCaller = true,
  introspections = 0;
let leakedRequests = 0;
const mintedVersions: number[] = [];
const accounts = [ownerA, ownerB, org];
const operation = (accountId: string) => `${accountId}-operation`;
function sessionToken(accountId: string): string {
  return `e30.${Buffer.from(
    JSON.stringify({
      sessionId: `session:${accountId}`,
      userId: accountId,
      exp: Date.parse(expiry) / 1000,
    }),
  ).toString('base64url')}.fixture`;
}
async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const credentials = (name: string) => async () => ({
  AccessKeyId: `test-${name}`,
  SecretAccessKey: 'test-only-no-aws-secret',
  Token: 'test-temporary-session',
});

suite('Clarity SDK → HTTP → shared live authority → account-owned operations', () => {
  beforeAll(async () => {
    if (new URL(databaseUrl).pathname !== '/clarity_ci') throw new Error('Use clarity_ci only');
    connectPostgres(databaseUrl);
    await getDb()
      .insert(crawlJobs)
      .values(
        accounts.map((accountId) => ({
          id: operation(accountId),
          ownerAccountId: accountId,
          applicationId,
          kind: 'urls',
          callerTier: 'internal',
          status: 'queued',
          idempotencyKey: 'same-intent',
        })),
      );
    const authority = express();
    authority.use(express.json());
    authority.post('/auth/service-token/workload/challenge', (_req, res) =>
      res.json({ nonce: 'test-challenge' }),
    );
    authority.post('/auth/service-token/workload', (req, res) => {
      const receiver = req.body.attestation?.headers?.authorization?.includes('test-receiver/');
      const appId = receiver ? CLARITY_SERVICE_APPLICATION_ID : applicationId;
      const audience = req.body.audience ?? 'oxy-api';
      const now = Math.floor(Date.now() / 1000);
      const token = `e30.${Buffer.from(
        JSON.stringify({
          type: 'service',
          authority: 'first_party',
          appId,
          credentialId: `wl_${appId}`,
          ownerAccountId: receiver ? 'clarity-owner' : ownerA,
          environment: 'production',
          aud: audience,
          iss: 'oxy-auth',
          iat: now,
          exp: now + 300,
          nonce: crypto.randomUUID(),
        }),
      ).toString('base64url')}.fixture`;
      mintedVersions.push(req.body.protocolVersion ?? 1);
      principals.set(token, {
        active: true,
        permissions: [],
        kind: 'service',
        authority: 'first_party',
        applicationId: appId,
        accountId: receiver ? 'clarity-owner' : ownerA,
        credentialId: `wl_${appId}`,
        environment: 'production',
        audience,
        expiresAt: new Date((now + 300) * 1000).toISOString(),
      });
      res.json({ token, expiresIn: 300, appName: 'Fixture' });
    });
    authority.get('/leak', (_req, res) => {
      leakedRequests += 1;
      res.json({});
    });
    authority.post('/auth/resources/introspect', (req, res) => {
      const receiving = principals.get(req.header('authorization')?.replace(/^Bearer /, '') ?? '');
      if (
        receiving?.applicationId !== CLARITY_SERVICE_APPLICATION_ID ||
        receiving.audience !== 'oxy-api'
      ) {
        res.status(403).json({ error: 'wrong_receiver' });
        return;
      }
      introspections += 1;
      const principal = principals.get(req.body.token);
      res.json(
        !liveCaller && principal?.kind === 'service' && principal.applicationId === applicationId
          ? { active: false }
          : (principal ?? { active: false }),
      );
    });
    const authorityServer = await listen(authority);
    oxyHttp = authorityServer.server;
    oxyUrl = authorityServer.url;
    identity.receiver = new OxyServer({
      baseURL: oxyUrl,
      workloadCredentials: credentials('receiver'),
    });
    caller = new OxyServer({ baseURL: oxyUrl, workloadCredentials: credentials('caller') });
    const product = express();
    product.use(express.json());
    product.get('/v1/operations/redirect', (_req, res) => res.redirect(307, `${oxyUrl}/leak`));
    product.use('/v1', router);
    const productServer = await listen(product);
    productHttp = productServer.server;
    productUrl = productServer.url;
    own = clarityForOxyService(caller, { baseUrl: productUrl });
    sessions = new OxyServices({ baseURL: oxyUrl });
    personal = clarityForOxySession(sessions, { baseUrl: productUrl });
    for (const accountId of accounts)
      principals.set(sessionToken(accountId), {
        active: true,
        permissions: [],
        kind: 'session',
        authority: 'first_party',
        accountId,
        effectiveAccountId: accountId,
        requesterAccountId: ownerA,
        applicationId: null,
        expiresAt: expiry,
      });
  });
  afterAll(async () => {
    own?.dispose();
    personal?.dispose();
    caller?.dispose();
    identity.receiver?.dispose();
    sessions?.dispose();
    await getDb().delete(crawlJobs).where(inArray(crawlJobs.ownerAccountId, accounts));
    await getDb()
      .delete(searchRateLimitBuckets)
      .where(
        inArray(searchRateLimitBuckets.dimensionId, [
          ...accounts,
          applicationId,
          `wl_${applicationId}`,
          `${prefix}-key`,
        ]),
      );
    await closePostgres();
    for (const server of [productHttp, oxyHttp])
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sends canonical scope-less workload authority and enforces operation ownership', async () => {
    expect((await own.operations.get(operation(ownerA))).id).toBe(operation(ownerA));
    await expect(own.operations.get(operation(ownerB))).rejects.toMatchObject({ status: 404 });
    expect(mintedVersions.every((version) => version === 2)).toBe(true);
  });
  it('rejects a valid workload token meant for another recipient', async () => {
    const wrong = new ClarityClient({
      baseUrl: productUrl,
      transport: caller.createServiceClient({ baseURL: productUrl, audience: 'oxy-service:wrong' }),
    });
    await expect(wrong.operations.get(operation(ownerA))).rejects.toMatchObject({ status: 401 });
    wrong.dispose();
  });
  it('keeps old verified workload callers working only through central explicit projection', async () => {
    principals.set('legacy-workload', {
      active: true,
      permissions: [],
      kind: 'service',
      authority: 'first_party',
      accountId: ownerA,
      applicationId,
      credentialId: 'wl_known-cohort',
      environment: 'production',
      audience: 'oxy-api',
      expiresAt: expiry,
    });
    const legacy = new ClarityClient({ baseUrl: productUrl, accessToken: 'legacy-workload' });
    expect((await legacy.operations.get(operation(ownerA))).id).toBe(operation(ownerA));
  });
  it('switches the shared session account without leaking cached operations or inventing an app', async () => {
    sessions.session.setAccessToken(sessionToken(ownerA));
    expect((await personal.operations.get(operation(ownerA))).id).toBe(operation(ownerA));
    sessions.session.setAccessToken(sessionToken(ownerB));
    expect((await personal.operations.get(operation(ownerB))).id).toBe(operation(ownerB));
    await expect(personal.operations.get(operation(ownerA))).rejects.toMatchObject({ status: 404 });
    sessions.session.setAccessToken(sessionToken(org));
    expect((await personal.operations.get(operation(org))).id).toBe(operation(org));
    await expect(personal.operations.get(operation(ownerA))).rejects.toMatchObject({ status: 404 });
  });
  it('separates equal intent keys across human accounts and records session attribution', async () => {
    const key = `${prefix}:same-key`;
    sessions.session.setAccessToken(sessionToken(ownerA));
    const a = await personal.indexing.urls(
      { urls: ['https://example.com/a'] },
      { idempotencyKey: key },
    );
    sessions.session.setAccessToken(sessionToken(ownerB));
    const b = await personal.indexing.urls(
      { urls: ['https://example.com/b'] },
      { idempotencyKey: key },
    );
    expect(a.id).not.toBe(b.id);
    const rows = await getDb()
      .select()
      .from(crawlJobs)
      .where(inArray(crawlJobs.id, [a.id, b.id]));
    expect(new Set(rows.map((row) => row.ownerAccountId))).toEqual(new Set([ownerA, ownerB]));
    for (const row of rows)
      expect(row).toMatchObject({
        applicationId: '',
        callerKind: 'session',
        callerAuthority: 'first_party',
      });
    sessions.session.setAccessToken(sessionToken(ownerA));
    expect(
      (await personal.indexing.urls({ urls: ['https://example.com/a'] }, { idempotencyKey: key }))
        .id,
    ).toBe(a.id);
  });
  it('does not promote historical internal jobs during migration', async () => {
    const rows = await getDb()
      .select()
      .from(crawlJobs)
      .where(inArray(crawlJobs.id, accounts.map(operation)));
    for (const row of rows)
      expect(row).toMatchObject({
        callerTier: 'internal',
        callerAuthority: 'external',
        callerKind: 'legacy',
      });
  });
  it('rejects revoked managed-account membership on the next linked request', async () => {
    sessions.session.setAccessToken(sessionToken(org));
    await personal.operations.get(operation(org));
    const valid = principals.get(sessionToken(org));
    principals.set(sessionToken(org), { active: false });
    await expect(personal.operations.get(operation(org))).rejects.toMatchObject({ status: 401 });
    if (valid) principals.set(sessionToken(org), valid);
  });
  it('never follows a redirect with workload or external-key authority', async () => {
    await expect(own.operations.get('redirect')).rejects.toThrow();
    const external = new ClarityClient({ baseUrl: productUrl, apiKey: 'oxy_sk_redirect' });
    await expect(external.operations.get('redirect')).rejects.toThrow();
    expect(leakedRequests).toBe(0);
  });
  it('accepts the real external-key shape with no expiry/audience and still requires scope', async () => {
    const key = {
      active: true,
      permissions: [],
      kind: 'key',
      authority: 'external',
      accountId: ownerA,
      applicationId,
      credentialId: `${prefix}-key`,
      environment: 'production',
      tier: 'internal',
      scopes: [],
    };
    principals.set('oxy_sk_fixture', key);
    const external = new ClarityClient({ baseUrl: productUrl, apiKey: 'oxy_sk_fixture' });
    await expect(external.operations.get(operation(ownerA))).rejects.toMatchObject({ status: 403 });
    principals.set('oxy_sk_fixture', { ...key, scopes: ['clarity:index'] });
    expect((await external.operations.get(operation(ownerA))).id).toBe(operation(ownerA));
    await expect(external.operations.get(operation(ownerB))).rejects.toMatchObject({ status: 404 });
    principals.set('oxy_sk_fixture', { active: false });
    await expect(external.operations.get(operation(ownerA))).rejects.toMatchObject({ status: 401 });
  });
  it('keeps external OAuth scopes even when its account is also an own-session account', async () => {
    principals.set('external-oauth', {
      active: true,
      permissions: [],
      kind: 'session',
      authority: 'external',
      accountId: ownerA,
      effectiveAccountId: ownerA,
      requesterAccountId: ownerA,
      applicationId: 'external-app',
      scopes: ['clarity:search'],
      expiresAt: expiry,
    });
    const external = new ClarityClient({ baseUrl: productUrl, accessToken: 'external-oauth' });
    await expect(external.operations.get(operation(ownerA))).rejects.toMatchObject({ status: 403 });
  });
  it('checks live workload revocation after a successful request', async () => {
    await own.operations.get(operation(ownerA));
    const before = introspections;
    liveCaller = false;
    await expect(own.operations.get(operation(ownerA))).rejects.toMatchObject({ status: 401 });
    expect(introspections).toBeGreaterThan(before);
    liveCaller = true;
  });
});
