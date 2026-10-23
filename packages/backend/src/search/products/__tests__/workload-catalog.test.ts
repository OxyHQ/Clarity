import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  identity: vi.fn(),
  fetch: vi.fn(),
  dispose: vi.fn(),
  create: vi.fn(),
}));
vi.mock('../../../lib/clarity-service-auth.js', () => ({
  hasExactClarityServiceConfiguration: () => true,
  assertClarityWorkloadIdentity: mock.identity,
  clarityOxyServer: () => ({ createServiceClient: mock.create }),
}));
import { searchProducts, setMercariaFetchForTests } from '../mercaria-catalog.js';
const publicFetch = vi.fn<typeof fetch>();
beforeEach(() => {
  setMercariaFetchForTests(undefined);
  vi.clearAllMocks();
  mock.identity.mockResolvedValue(undefined);
  mock.fetch.mockImplementation(async () => Response.json({ items: [], nextCursor: null }));
  mock.create.mockReturnValue({ fetch: mock.fetch, dispose: mock.dispose });
  publicFetch.mockImplementation(async () => Response.json({ items: [], nextCursor: null }));
  vi.stubGlobal('fetch', publicFetch);
});
afterEach(() => {
  setMercariaFetchForTests(undefined);
  vi.unstubAllGlobals();
});
describe('Mercaria public catalogue workload transport', () => {
  it('uses the product factory with the canonical receiver and no local bearer', async () => {
    expect((await searchProducts({ query: 'headphones' })).results).toEqual([]);
    expect(mock.create).toHaveBeenCalledWith({
      baseURL: 'https://api.mercaria.co',
      audience: 'oxy-service:6a37d0cc5d4b5f15482a9340',
    });
    expect(new Headers(mock.fetch.mock.calls[0][1].headers).has('authorization')).toBe(false);
    expect(publicFetch).not.toHaveBeenCalled();
  });
  it('retains anonymous catalogue reads when the original workload cannot attest', async () => {
    mock.identity.mockRejectedValue(new Error('temporary role unavailable'));
    expect((await searchProducts({ query: 'headphones' })).results).toEqual([]);
    expect(mock.create).not.toHaveBeenCalled();
    expect(new Headers(publicFetch.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false);
  });
  it('does not turn an authenticated receiver denial into an anonymous retry', async () => {
    mock.fetch.mockResolvedValue(
      Response.json({ error: { code: 'forbidden', message: 'denied' } }, { status: 403 }),
    );
    await expect(searchProducts({ query: 'headphones' })).rejects.toThrow();
    expect(mock.fetch).toHaveBeenCalledOnce();
    expect(publicFetch).not.toHaveBeenCalled();
  });
});
