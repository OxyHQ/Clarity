import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = {
  cursor: vi.fn(),
  commit: vi.fn(),
  token: vi.fn(),
  claims: vi.fn(),
  list: vi.fn(),
  verify: vi.fn(),
};
vi.mock('../db/experience-repository.js', () => ({
  readAccountEventCursor: mock.cursor,
  commitAccountEventPage: mock.commit,
}));
vi.mock('../middleware/auth.js', () => ({
  oxyClient: { serviceToken: mock.token, accountEvents: { list: mock.list, verify: mock.verify } },
}));
vi.mock('../lib/clarity-service-auth.js', () => ({ assertExactClarityServiceClaims: mock.claims }));
const { reconcileAccountEvents } = await import('../lib/account-event-reconciliation.js');
import { CLARITY_IDENTITY } from '../lib/clarity-identity.js';
const applicationId = CLARITY_IDENTITY.backendApplication.applicationId;
beforeEach(() => {
  vi.resetAllMocks();
  mock.cursor.mockResolvedValue('cursor-old');
  mock.token.mockResolvedValue('service-token');
  mock.commit.mockResolvedValue(true);
});
describe('signed account event feed reconciliation', () => {
  it('resumes the durable cursor and commits only verified identities', async () => {
    mock.list.mockResolvedValue({
      events: [{ token: 'signed-event', userId: 'forged-metadata' }],
      nextCursor: 'cursor-next',
    });
    mock.verify.mockResolvedValue({ userId: 'verified-person', eventId: 'verified-event' });
    expect(await reconcileAccountEvents()).toBe(1);
    expect(mock.token).toHaveBeenCalledWith(undefined, undefined, {
      scopes: [...CLARITY_IDENTITY.backendApplication.scopes],
    });
    expect(mock.claims).toHaveBeenCalledWith('service-token');
    expect(mock.list).toHaveBeenCalledWith({ after: 'cursor-old', limit: 100 });
    expect(mock.verify).toHaveBeenCalledWith('signed-event', { audience: applicationId });
    expect(mock.commit).toHaveBeenCalledWith(applicationId, 'cursor-old', 'cursor-next', [
      { userId: 'verified-person', eventId: 'verified-event' },
    ]);
  });
  it('does not consume any part of a page containing an invalid signature or audience', async () => {
    mock.list.mockResolvedValue({
      events: [{ token: 'good' }, { token: 'invalid' }],
      nextCursor: 'cursor-next',
    });
    mock.verify
      .mockResolvedValueOnce({ userId: 'person', eventId: 'event' })
      .mockRejectedValueOnce(new Error('wrong audience'));
    await expect(reconcileAccountEvents()).rejects.toThrow('wrong audience');
    expect(mock.commit).not.toHaveBeenCalled();
  });
  it('refuses another backend identity before requesting the feed', async () => {
    mock.claims.mockImplementation(() => {
      throw new Error('wrong app');
    });
    await expect(reconcileAccountEvents()).rejects.toThrow('wrong app');
    expect(mock.list).not.toHaveBeenCalled();
  });
  it('stops when another worker already committed the page', async () => {
    mock.list.mockResolvedValue({ events: [{ token: 'signed' }], nextCursor: 'next' });
    mock.verify.mockResolvedValue({ userId: 'person', eventId: 'event' });
    mock.commit.mockResolvedValue(false);
    expect(await reconcileAccountEvents()).toBe(0);
    expect(mock.list).toHaveBeenCalledTimes(1);
  });
  it('refuses a nonadvancing feed instead of repeatedly replaying it', async () => {
    mock.list.mockResolvedValue({ events: [{ token: 'signed' }], nextCursor: 'cursor-old' });
    await expect(reconcileAccountEvents()).rejects.toThrow('did not advance');
    expect(mock.commit).not.toHaveBeenCalled();
  });
});
