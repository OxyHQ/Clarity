import { describe, expect, it, vi } from 'vitest';
import { ClarityClient } from '../src/client.js';
import { experienceInputSchema } from '../src/experience.js';

const resource = { id: 'id', oxyUserId: 'owner', createdAt: '2022-10-01T00:00:00Z', updatedAt: '2022-10-01T00:00:00Z' };
const input = { title: 'Designer', companyName: 'Apple', startDate: '2022-10', endDate: null };
describe('public profile experience contract', () => {
  it('accepts current roles and same-month roles', () => {
    expect(experienceInputSchema.parse(input)).toEqual(input);
    expect(experienceInputSchema.safeParse({ ...input, endDate: '2022-10' }).success).toBe(true);
  });
  it.each(['2022-00', '2022-13', '22-01', '2022-01-01', '2022-1', '2099-01'])('rejects invalid/future start month %s', startDate => {
    expect(experienceInputSchema.safeParse({ ...input, startDate }).success).toBe(false);
  });
  it('rejects reversed periods, empty fields and identity assignment', () => {
    for (const patch of [{ endDate: '2021-01' }, { title: ' ' }, { companyName: '' }, { oxyUserId: 'another-user' }, { id: 'chosen-id' }]) {
      expect(experienceInputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    }
  });
  it('sends user-authenticated writes to Clarity, using full replacement', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify(init?.method === 'GET' ? { items: [], nextCursor: null } : { ...input, ...resource }));
    });
    const client = new ClarityClient({ accessToken: 'user-session', baseUrl: 'https://clarity.test', fetch: fetcher });
    await client.experience.list('oxy/user');
    await client.experience.create(input);
    await client.experience.update('row/1', input);
    await client.experience.delete('row/1');
    await client.experience.clear();
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://clarity.test/api/experience/users/oxy%2Fuser', 'GET'],
      ['https://clarity.test/api/experience', 'POST'],
      ['https://clarity.test/api/experience/row%2F1', 'PUT'],
      ['https://clarity.test/api/experience/row%2F1', 'DELETE'],
      ['https://clarity.test/api/experience', 'DELETE'],
    ]);
    expect(new Headers(fetcher.mock.calls[2][1]?.headers).get('authorization')).toBe('Bearer user-session');
    expect(fetcher.mock.calls[2][1]?.body).toBe(JSON.stringify(input));
  });
  it('reads public profiles anonymously without an Authorization header', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ items: [], nextCursor: null })));
    await new ClarityClient({ fetch: fetcher }).experience.list('user');
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('authorization')).toBe(false);
  });
  it('rejects an incompatible public profile response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ items: [{ title: 'untrusted' }], nextCursor: null })));
    await expect(new ClarityClient({ fetch: fetcher }).experience.list('user')).rejects.toThrow();
  });
  it('surfaces owner errors without retrying writes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: {
      code: 'not_found', message: 'Experience not found', requestId: 'request-id',
    } }), { status: 404 }));
    const client = new ClarityClient({ accessToken: 'user-session', fetch: fetcher });
    await expect(client.experience.update('another-owners-entry', input)).rejects.toMatchObject({
      name: 'ClarityError', code: 'not_found', status: 404,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
