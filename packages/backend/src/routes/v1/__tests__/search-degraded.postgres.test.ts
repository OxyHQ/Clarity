import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../../db/index.js';
import { searchUsageEvents } from '../../../db/schema/index.js';
import type { ClarityResourcePrincipal } from '../../../middleware/resource-auth.js';

/**
 * `POST /v1/search` without the embeddings capability: hybrid ranks lexically
 * and says so in `degraded`, semantic is refused, and Kaana is never called.
 */
const owner = `search-degraded-test-${crypto.randomUUID()}`;
const principal: ClarityResourcePrincipal = {
  active: true,
  permissions: [],
  kind: 'service',
  accountId: owner,
  applicationId: 'app-search-degraded',
  credentialId: 'credential-search-degraded',
  authority: 'first_party',
  environment: 'development',
  audience: 'oxy-api',
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const embeddings = vi.hoisted(() => ({ enabled: vi.fn(() => false), create: vi.fn() }));
vi.mock('../../../middleware/resource-auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../middleware/resource-auth.js')>()),
  authenticateResource: (req: Request, _res: Response, next: NextFunction) => {
    req.resourcePrincipal = principal;
    next();
  },
  requireResourceRequestRate: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../../lib/kaana-embeddings.js', () => ({
  CLARITY_EMBEDDING_MODEL: 'test-embedding-model',
  embeddingsEnabled: embeddings.enabled,
  createEmbeddings: embeddings.create,
}));
const { default: router } = await import('../search-platform.js');

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
if (databaseUrl && new URL(databaseUrl).pathname !== '/clarity_ci')
  throw new Error('Use only clarity_ci');
const suite = databaseUrl ? describe : describe.skip;

let server: Server;
let origin: string;
const search = (mode: string) =>
  fetch(`${origin}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'pixel camera', mode }),
  });

suite('POST /v1/search without the embeddings capability', () => {
  beforeAll(async () => {
    connectPostgres(databaseUrl);
    const app = express();
    app.use(express.json());
    app.use(router);
    server = app.listen(0);
    await new Promise((done) => server.once('listening', done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => {
    await getDb().delete(searchUsageEvents).where(eq(searchUsageEvents.ownerAccountId, owner));
    await new Promise<void>((done) => server.close(() => done()));
    await closePostgres();
  });

  it('ranks a hybrid search lexically and reports it', async () => {
    const response = await search('hybrid');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mode: 'hybrid',
      degraded: { from: 'hybrid', to: 'lexical', reason: 'embedding_route_unavailable' },
    });
    expect(embeddings.create).not.toHaveBeenCalled();
  });

  it('refuses a semantic search', async () => {
    const response = await search('semantic');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'semantic_unavailable' } });
    expect(embeddings.create).not.toHaveBeenCalled();
  });

  it('does not degrade a lexical search', async () => {
    const response = await search('lexical');
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('degraded');
  });
});
