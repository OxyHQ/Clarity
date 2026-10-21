import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const repository = vi.hoisted(() => ({
  listExperience: vi.fn(), createExperience: vi.fn(), updateExperience: vi.fn(),
  deleteExperience: vi.fn(), eraseUserExperience: vi.fn(),
}));
vi.mock('../../db/experience-repository.js', () => ({ ...repository, ExperienceAccountErasedError: class extends Error {}, ExperienceLimitError: class extends Error {} }));
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const user = req.headers['test-user'];
    if (typeof user === 'string') req.user = { id: user, kind: req.headers['test-kind'] || 'personal' };
    if (req.headers['test-service']) req.serviceApp = {} as NonNullable<express.Request['serviceApp']>;
    next();
  },
}));
import router from '../experience.js';
const input = { title: 'Designer', companyName: 'Apple', startDate: '2022-10', endDate: null };
let server: Server;
let base: string;
async function request(path: string, method = 'GET', user?: string, body?: unknown, headers?: Record<string, string>) {
  return fetch(`${base}${path}`, { method, headers: {
    'content-type': 'application/json', ...(user ? { 'test-user': user } : {}), ...headers,
  }, body: body === undefined ? undefined : JSON.stringify(body) });
}
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api/experience', router);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/experience`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => vi.resetAllMocks());

describe('Experience HTTP API', () => {
  it('allows public reads without storing a viewer', async () => {
    repository.listExperience.mockResolvedValue([]);
    const response = await request('/users/owner');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], nextCursor: null });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(repository.listExperience).toHaveBeenCalledWith('owner');
  });
  it('requires a personal user session for every write', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect((await request(method === 'POST' ? '' : '/id', method, undefined, method === 'DELETE' ? undefined : input)).status).toBe(401);
    }
    expect((await request('', 'POST', 'owner', input, { 'test-kind': 'organization' })).status).toBe(403);
    expect((await request('', 'POST', 'owner', input, { 'test-service': 'yes' })).status).toBe(401);
    expect(repository.createExperience).not.toHaveBeenCalled();
  });
  it('rejects ownership mass assignment and invalid dates', async () => {
    for (const patch of [{ oxyUserId: 'victim' }, { endDate: '2020-01' }, { startDate: '2022-13' }]) {
      const response = await request('', 'POST', 'owner', { ...input, ...patch });
      const malformed = 'oxyUserId' in patch;
      expect(response.status).toBe(malformed ? 400 : 422);
      expect(await response.json()).toMatchObject({ error: { code: malformed ? 'bad_request' : 'validation_failed' } });
    }
    expect(repository.createExperience).not.toHaveBeenCalled();
  });
  it('creates rows for the verified owner only', async () => {
    repository.createExperience.mockResolvedValue({ ...input, id: 'generated', oxyUserId: 'owner' });
    const response = await request('', 'POST', 'owner', input);
    expect(response.status).toBe(201);
    expect(repository.createExperience).toHaveBeenCalledWith('owner', input);
  });
  it('scopes replacements and deletions to owner and hides other accounts entries', async () => {
    repository.updateExperience.mockResolvedValue(null);
    repository.deleteExperience.mockResolvedValue(false);
    expect((await request('/victim-entry', 'PUT', 'owner', input)).status).toBe(404);
    expect(repository.updateExperience).toHaveBeenCalledWith('owner', 'victim-entry', input);
    expect((await request('/victim-entry', 'DELETE', 'owner')).status).toBe(404);
    expect(repository.deleteExperience).toHaveBeenCalledWith('owner', 'victim-entry');
  });
  it('erases all experience only for the verified owner', async () => {
    expect((await request('', 'DELETE', 'owner')).status).toBe(204);
    expect(repository.eraseUserExperience).toHaveBeenCalledWith('owner');
  });
  it('returns structured errors without leaking database details', async () => {
    repository.listExperience.mockRejectedValue(new Error('private database connection details'));
    const response = await request('/users/owner');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'service_unavailable', message: 'Experience is temporarily unavailable' } });
  });
});
