import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const repository = {
  listExperience: vi.fn(),
  createExperience: vi.fn(),
  updateExperience: vi.fn(),
  deleteExperience: vi.fn(),
  eraseUserExperience: vi.fn(),
  organization: vi.fn(),
  account: vi.fn(),
  profileAccess: vi.fn(),
};
vi.mock('../../db/experience-repository.js', () => ({
  ...repository,
  ExperienceAccountErasedError: class extends Error {},
  ExperienceLimitError: class extends Error {},
}));
vi.mock('../../middleware/auth.js', () => ({
  oxyClient: {
    organizations: { get: repository.organization },
    users: { get: repository.account },
    safety: { profileAccess: repository.profileAccess },
  },
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const user = req.headers['test-user'];
    if (typeof user === 'string')
      req.user = {
        id: user,
        kind:
          req.headers['test-kind'] === 'missing'
            ? undefined
            : req.headers['test-kind'] || 'personal',
      };
    if (req.headers['test-service'])
      req.serviceApp = {} as NonNullable<express.Request['serviceApp']>;
    next();
  },
}));
const { default: router } = await import('../experience.js');
const input = {
  title: 'Designer',
  employerOxyAccountId: 'organization-apple',
  startDate: '2022-10',
  endDate: null,
};
let server: Server;
let base: string;
async function request(
  path: string,
  method = 'GET',
  user?: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(user ? { 'test-user': user } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/experience', router);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/experience`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  vi.resetAllMocks();
  repository.profileAccess.mockResolvedValue({
    allowed: true,
    reason: 'public',
    policyVersion: '1',
  });
  repository.organization.mockResolvedValue({ accountId: 'organization-apple', status: 'active' });
});

describe('Experience HTTP API', () => {
  it('requires a canonical employer and rejects mutable company fields', async () => {
    for (const patch of [
      { companyName: 'Apple' },
      { companyOxyUserId: 'arbitrary' },
      { employerOxyAccountId: '' },
    ]) {
      const response = await request('', 'POST', 'owner', { ...input, ...patch });
      expect([400, 422]).toContain(response.status);
    }
    const { employerOxyAccountId: _employer, ...withoutEmployer } = input;
    expect((await request('', 'POST', 'owner', withoutEmployer)).status).toBe(400);
    expect(repository.createExperience).not.toHaveBeenCalled();
  });
  it('persists the resolved organization ID for renamed or merged employers', async () => {
    repository.organization.mockResolvedValue({ accountId: 'canonical-org', status: 'active' });
    repository.createExperience.mockResolvedValue({
      ...input,
      employerOxyAccountId: 'canonical-org',
      id: 'generated',
      oxyUserId: 'owner',
    });
    expect((await request('', 'POST', 'owner', input)).status).toBe(201);
    expect(repository.createExperience).toHaveBeenCalledWith('owner', {
      ...input,
      employerOxyAccountId: 'canonical-org',
    });
  });
  it('allows inactive historical employers while refusing suppressed or nonexistent organizations', async () => {
    repository.organization.mockResolvedValueOnce({
      accountId: 'organization-apple',
      status: 'inactive',
    });
    repository.createExperience.mockResolvedValue(input);
    expect((await request('', 'POST', 'owner', input)).status).toBe(201);
    for (const status of ['suppressed', 'merged']) {
      repository.organization.mockResolvedValueOnce({ accountId: 'organization-apple', status });
      const response = await request('', 'POST', 'owner', input);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_employer' } });
    }
    repository.organization.mockRejectedValueOnce({ status: 404 });
    expect((await request('', 'POST', 'owner', input)).status).toBe(422);
    expect(repository.createExperience).toHaveBeenCalledTimes(1);
  });
  it('fails closed on an Oxy directory outage without creating a local company fallback', async () => {
    repository.organization.mockRejectedValue(new Error('directory unavailable'));
    expect((await request('', 'POST', 'owner', input)).status).toBe(503);
    expect(repository.createExperience).not.toHaveBeenCalled();
  });
  it('allows public reads without storing a viewer', async () => {
    repository.listExperience.mockResolvedValue([]);
    const response = await request('/users/owner');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], nextCursor: null });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(repository.listExperience).toHaveBeenCalledWith('owner');
  });
  it.each(['private', 'blocked', 'unavailable'])(
    'never reads stored history after a denied %s profile decision',
    async (reason) => {
      repository.profileAccess.mockResolvedValue({ allowed: false, reason, policyVersion: '1' });
      const response = await request('/users/owner');
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: { code: 'not_found', message: 'Experience is not available' },
      });
      expect(repository.profileAccess).toHaveBeenCalledWith(
        { subjectAccountId: 'owner' },
        { accessToken: null },
      );
      expect(repository.listExperience).not.toHaveBeenCalled();
    },
  );
  it('forwards only the optional original bearer to the central visibility decision', async () => {
    repository.profileAccess.mockResolvedValue({
      allowed: true,
      reason: 'owner',
      policyVersion: '1',
    });
    repository.listExperience.mockResolvedValue([]);
    expect(
      (
        await request('/users/owner', 'GET', undefined, undefined, {
          authorization: 'Bearer owner-session',
        })
      ).status,
    ).toBe(200);
    expect(repository.profileAccess).toHaveBeenCalledWith(
      { subjectAccountId: 'owner' },
      { accessToken: 'owner-session' },
    );
    expect(repository.listExperience).toHaveBeenCalledWith('owner');
  });
  it('fails closed during a visibility outage and never downgrades an invalid session to anonymous', async () => {
    repository.profileAccess.mockRejectedValueOnce(new Error('Oxy unavailable'));
    expect((await request('/users/owner')).status).toBe(503);
    repository.profileAccess.mockRejectedValueOnce({ status: 401 });
    expect(
      (
        await request('/users/owner', 'GET', undefined, undefined, {
          authorization: 'Bearer invalid-session',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request('/users/owner', 'GET', undefined, undefined, {
          authorization: 'Basic invalid',
        })
      ).status,
    ).toBe(401);
    expect(repository.listExperience).not.toHaveBeenCalled();
  });
  it('requires a personal user session for every write', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect(
        (
          await request(
            method === 'POST' ? '' : '/id',
            method,
            undefined,
            method === 'DELETE' ? undefined : input,
          )
        ).status,
      ).toBe(401);
    }
    expect(
      (await request('', 'POST', 'owner', input, { 'test-kind': 'organization' })).status,
    ).toBe(403);
    expect((await request('', 'POST', 'owner', input, { 'test-service': 'yes' })).status).toBe(401);
    expect(repository.createExperience).not.toHaveBeenCalled();
  });
  it('resolves missing account kinds authoritatively and fails closed', async () => {
    repository.account.mockResolvedValueOnce({ id: 'owner', kind: 'organization' });
    expect((await request('', 'POST', 'owner', input, { 'test-kind': 'missing' })).status).toBe(
      403,
    );
    expect(repository.account).toHaveBeenCalledWith('owner', { cache: false });
    repository.account.mockRejectedValueOnce(new Error('identity unavailable'));
    expect((await request('', 'POST', 'owner', input, { 'test-kind': 'missing' })).status).toBe(
      503,
    );
    repository.account.mockResolvedValueOnce({ id: 'owner' });
    expect((await request('', 'POST', 'owner', input, { 'test-kind': 'missing' })).status).toBe(
      403,
    );
    expect(repository.createExperience).not.toHaveBeenCalled();
  });
  it('rejects ownership mass assignment and invalid dates', async () => {
    for (const patch of [
      { oxyUserId: 'victim' },
      { endDate: '2020-01' },
      { startDate: '2022-13' },
    ]) {
      const response = await request('', 'POST', 'owner', { ...input, ...patch });
      const malformed = 'oxyUserId' in patch;
      expect(response.status).toBe(malformed ? 400 : 422);
      expect(await response.json()).toMatchObject({
        error: { code: malformed ? 'bad_request' : 'validation_failed' },
      });
    }
    expect(repository.createExperience).not.toHaveBeenCalled();
  });
  it('creates rows for the verified owner only', async () => {
    repository.createExperience.mockResolvedValue({
      ...input,
      id: 'generated',
      oxyUserId: 'owner',
    });
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
    expect(await response.json()).toMatchObject({
      error: { code: 'service_unavailable', message: 'Experience is temporarily unavailable' },
    });
  });
});
