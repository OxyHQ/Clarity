import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLARITY_AGENT_MANIFEST } from '../../lib/clarity-agent-manifest.js';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), erase: vi.fn() }));
vi.mock('../../middleware/auth.js', () => ({ oxyClient: { accountEvents: { verify: mocks.verify } } }));
vi.mock('../../db/experience-repository.js', () => ({ eraseDeletedAccountExperience: mocks.erase }));
import router from '../oxy-account-events.js';
let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer(express().use('/webhooks', router));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/oxy/account-events`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => vi.resetAllMocks());
const request = (body = 'header.payload.signature', contentType = 'application/secevent+jwt') => fetch(base, {
  method: 'POST', headers: { 'content-type': contentType }, body,
});
describe('verified Oxy account deletion', () => {
  it('requires compact security event content and bounds its size', async () => {
    expect((await request('{}', 'application/json')).status).toBe(415);
    expect((await request('unsigned')).status).toBe(400);
    expect((await request('a'.repeat(17 * 1024))).status).toBe(413);
    expect(mocks.erase).not.toHaveBeenCalled();
  });
  it('never erases unverified events and requests retry on unavailable verification', async () => {
    mocks.verify.mockRejectedValue(new Error('invalid signature or unavailable key'));
    expect((await request()).status).toBe(503);
    expect(mocks.erase).not.toHaveBeenCalled();
  });
  it('pins the audience and erases only the verified event account, acknowledging after commit', async () => {
    mocks.verify.mockResolvedValue({ userId: 'deleted-user', eventId: 'event-1' });
    expect((await request()).status).toBe(202);
    expect(mocks.verify).toHaveBeenCalledWith('header.payload.signature', {
      audience: CLARITY_AGENT_MANIFEST.backendApplication.applicationId,
    });
    expect(mocks.erase).toHaveBeenCalledWith('deleted-user', 'event-1');
  });
  it('does not acknowledge a failed erasure', async () => {
    mocks.verify.mockResolvedValue({ userId: 'deleted-user', eventId: 'event-1' });
    mocks.erase.mockRejectedValue(new Error('database unavailable'));
    expect((await request()).status).toBe(503);
  });
});
