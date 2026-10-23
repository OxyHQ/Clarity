import { describe, expect, it, vi } from 'vitest';
import { ClarityClient } from '../src/client.js';
import { clarityForOxySession } from '../src/linked.js';
import { clarityForOxyService, CLARITY_SERVICE_AUDIENCE } from '../src/server.js';

function transport() {
  return {
    fetch: vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify({ data: [] }))),
    dispose: vi.fn(),
  };
}

describe('shared Oxy transports', () => {
  it('pins workload calls to the receiving application and leaves bearer/refresh to Oxy', async () => {
    const linked = transport();
    const oxy = { createServiceClient: vi.fn(() => linked) };
    const client = clarityForOxyService(oxy, { baseUrl: 'https://clarity.test' });
    await client.indexing.urls({ urls: ['https://example.com'] }, { idempotencyKey: 'one' });
    expect(oxy.createServiceClient).toHaveBeenCalledExactlyOnceWith({
      baseURL: 'https://clarity.test',
      audience: CLARITY_SERVICE_AUDIENCE,
    });
    const [url, init] = linked.fetch.mock.calls[0];
    expect(url).toBe('https://clarity.test/v1/index/urls');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('one');
    client.dispose();
    expect(linked.dispose).toHaveBeenCalledOnce();
  });

  it('links personal Experience requests to the shared session without token callbacks', async () => {
    const linked = transport();
    linked.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], nextCursor: null })),
    );
    const oxy = { createLinkedClient: vi.fn(() => linked) };
    const client = clarityForOxySession(oxy);
    expect(await client.experience.list('person')).toEqual({ items: [], nextCursor: null });
    expect(oxy.createLinkedClient).toHaveBeenCalledOnce();
    expect(new Headers(linked.fetch.mock.calls[0][1]?.headers).has('authorization')).toBe(false);
    client.dispose();
    expect(linked.dispose).toHaveBeenCalledOnce();
  });

  it('never mixes credential authority with a workload/session transport', () => {
    expect(() => new ClarityClient({ transport: transport(), apiKey: 'external' })).toThrow(
      'exactly one',
    );
    expect(
      () => new ClarityClient({ transport: transport(), getAccessToken: () => 'external' }),
    ).toThrow('exactly one');
    expect(() => new ClarityClient({ transport: transport(), fetch })).toThrow('owns fetch');
  });

  it('does not add a second retry loop to the shared transport', async () => {
    const linked = transport();
    linked.fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'unavailable', code: 'unavailable' } }), {
        status: 503,
      }),
    );
    const client = clarityForOxyService({ createServiceClient: () => linked });
    await expect(client.documents.get('one')).rejects.toMatchObject({ status: 503 });
    expect(linked.fetch).toHaveBeenCalledOnce();
  });
});
