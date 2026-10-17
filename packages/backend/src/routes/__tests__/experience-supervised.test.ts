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
};
vi.mock('../../db/experience-repository.js', () => ({
  ...repository,
  ExperienceAccountErasedError: class extends Error {},
  ExperienceLimitError: class extends Error {},
}));
// The actual SDK middleware handles the HTTP bearer. Only its external
// session authority is replaced; Oxy's PG suite proves JWT/signature/revocation.
const { oxyClient, optionalAuth } = await import('../../middleware/auth.js');
const { default: router } = await import('../experience.js');
const publicRouters = [
  { name: 'jobs', router: (await import('../jobs.js')).default },
  { name: 'news', router: (await import('../news.js')).default },
  { name: 'market', router: (await import('../market.js')).default },
  { name: 'images', router: (await import('../images.js')).default },
  { name: 'favicons', router: (await import('../favicons.js')).default },
];
const validate = vi.spyOn(oxyClient.session, 'validate');
const profile = vi.spyOn(oxyClient.safety, 'profileAccess');
const content = vi.spyOn(oxyClient.safety, 'contentAccess');
const organization = vi.spyOn(oxyClient.organizations, 'get');
let server: Server;
let base: string;
const validUntil = Math.floor(Date.now() / 1000) + 300;
function token(id: string, expired = false) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ userId: id, sessionId: `session-${id}`, exp: expired ? 1 : validUntil })}.test-proof`;
}
async function request(path: string, bearer?: string, method = 'GET', body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/experience', router);
  for (const route of publicRouters) app.use(`/public/${route.name}`, route.router);
  app.get('/unreviewed', optionalAuth, (_req, res) => res.json({ publicContent: true }));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  vi.resetAllMocks();
  validate.mockImplementation(async (sessionId, options) => {
    const id = sessionId.replace('session-', '');
    if (options?.accessToken !== token(id))
      throw Object.assign(new Error('Invalid original proof'), { status: 401 });
    if (id === 'child' && options?.supervisedAction !== 'profile')
      throw Object.assign(new Error('Unsupported supervised action'), { status: 403 });
    return { valid: true, user: { id, username: id, kind: 'personal' } } as Awaited<
      ReturnType<typeof oxyClient.session.validate>
    >;
  });
  profile.mockResolvedValue({ allowed: true, reason: 'public', policyVersion: '1' });
  content.mockImplementation(async (input, requester) => ({
    allowed:
      !('accessToken' in requester) ||
      requester.accessToken !== token('child') ||
      (input.operation === 'manage_own' && input.authorAccountId === 'child'),
    reason: 'allowed',
    policyVersion: '2',
  }));
  repository.listExperience.mockResolvedValue([]);
  organization.mockResolvedValue({ accountId: 'employer', status: 'active' } as Awaited<
    ReturnType<typeof oxyClient.organizations.get>
  >);
});

describe('Experience with actual Oxy SDK HTTP middleware', () => {
  it.each(['public-adult', 'approved-contact', 'another-child'])(
    'denies unrated history of %s even when central profile privacy permits it',
    async (subject) => {
      expect((await request(`/experience/users/${subject}`, token('child'))).status).toBe(404);
      expect(content).toHaveBeenCalledWith(
        expect.objectContaining({
          authorAccountId: subject,
          classification: 'unrated',
          operation: 'read',
        }),
        { accessToken: token('child') },
      );
      expect(repository.listExperience).not.toHaveBeenCalled();
    },
  );
  it('allows verified own management and binds writes to the authenticated child', async () => {
    expect((await request('/experience/users/child', token('child'))).status).toBe(200);
    expect(content).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'manage_own', authorAccountId: 'child' }),
      { accessToken: token('child') },
    );
    const input = {
      title: 'Designer',
      employerOxyAccountId: 'employer',
      startDate: '2025-01',
      endDate: null,
    };
    repository.createExperience.mockResolvedValue({ ...input, id: 'entry', oxyUserId: 'child' });
    expect((await request('/experience', token('child'), 'POST', input)).status).toBe(201);
    expect(repository.createExperience).toHaveBeenCalledWith('child', input);
  });
  it('retains adult and anonymous reads while forwarding their exact policy requester', async () => {
    expect((await request('/experience/users/child', token('adult'))).status).toBe(200);
    expect((await request('/experience/users/adult')).status).toBe(200);
    expect(content).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'read' }), {
      accessToken: null,
    });
  });
  it.each([401, 403, 503])(
    'never converts authority refusal %s into anonymous content',
    async (status) => {
      validate.mockRejectedValue(Object.assign(new Error('Authority refusal'), { status }));
      for (const path of ['/experience/users/adult', '/unreviewed'])
        expect((await request(path, token('child'))).status).toBe(status);
      expect(profile).not.toHaveBeenCalled();
      expect(repository.listExperience).not.toHaveBeenCalled();
    },
  );
  it('fails closed on invalid, expired and unavailable original sessions', async () => {
    expect((await request('/experience/users/adult', token('child', true))).status).toBe(401);
    validate.mockResolvedValue(null as Awaited<ReturnType<typeof oxyClient.session.validate>>);
    expect((await request('/experience/users/adult', token('child'))).status).toBe(401);
    validate.mockRejectedValue(new Error('Network unavailable'));
    expect((await request('/experience/users/adult', token('child'))).status).toBe(503);
    expect(repository.listExperience).not.toHaveBeenCalled();
  });
  it('rejects supervised bearers on unreviewed public surfaces but keeps adult/anonymous access', async () => {
    expect((await request('/unreviewed', token('child'))).status).toBe(403);
    expect((await request('/unreviewed', token('adult'))).status).toBe(200);
    expect((await request('/unreviewed')).status).toBe(200);
  });
  it.each(['jobs', 'news', 'market', 'images', 'favicons'])(
    'rejects a supervised direct request before actual %s route data work',
    async (name) => {
      expect((await request(`/public/${name}`, token('child'))).status).toBe(403);
      validate.mockRejectedValueOnce(new Error('Oxy unavailable'));
      expect((await request(`/public/${name}`, token('child'))).status).toBe(503);
    },
  );
});
