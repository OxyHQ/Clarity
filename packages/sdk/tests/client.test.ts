import { describe, expect, it, vi } from 'vitest';
import { ClarityClient, ClarityError } from '../src/client.js';

describe('ClarityClient', () => {
  it('sends API keys and idempotency keys without Node-only APIs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'job_1', status: 'queued' }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new ClarityClient({ apiKey: 'oxy_sk_test', baseUrl: 'https://clarity.test/', fetch: fetcher });
    await client.indexing.urls({ urls: ['https://example.com'] }, { idempotencyKey: 'request-1' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://clarity.test/v1/index/urls');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer oxy_sk_test');
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('request-1');
  });

  it('returns typed API errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'scope_missing', message: 'Missing scope', requestId: 'req_1' },
    }), { status: 403, headers: { 'content-type': 'application/json' } }));
    const client = new ClarityClient({ accessToken: 'token', fetch: fetcher });
    const error = await client.search({ query: 'test' }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ClarityError);
    expect(error).toMatchObject({ code: 'scope_missing', status: 403, requestId: 'req_1' });
  });

  it('rejects ambiguous authentication', () => {
    expect(() => new ClarityClient({ apiKey: 'key', accessToken: 'token' })).toThrow('exactly one');
  });
});
