import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useJobSearch } from '../hooks/use-jobs';
import { useProductSearch } from '../hooks/use-products';

const request = vi.hoisted(() => vi.fn());
vi.mock('../api/public-request', () => ({ requestPublicApi: request }));

beforeEach(() => {
  request.mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(['jobs', 'products'] as const)('%s search pagination', (kind) => {
  it('stops a cyclic cursor while retaining the returned pages', async () => {
    const cursors = ['a', 'b', 'a'];
    request.mockImplementation(async () => ({
      data: [],
      results: [],
      nextCursor: cursors[request.mock.calls.length - 1],
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    let current!: ReturnType<typeof useJobSearch> | ReturnType<typeof useProductSearch>;
    let renderer!: ReactTestRenderer;
    const useSearch =
      kind === 'jobs' ? () => useJobSearch({}) : () => useProductSearch('tea', 'gb');
    function Probe() {
      current = useSearch();
      return null;
    }
    async function waitForPages(count: number) {
      for (let attempt = 0; attempt < 100 && current.data?.pages.length !== count; attempt++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
      expect(current.data?.pages).toHaveLength(count);
    }
    try {
      await act(async () => {
        renderer = create(createElement(QueryClientProvider, { client }, createElement(Probe)));
      });
      await waitForPages(1);
      for (let index = 0; index < 2; index++) {
        await act(async () => {
          await current.fetchNextPage();
        });
        await waitForPages(index + 2);
      }
      expect(current.hasNextPage).toBe(false);
      expect(request).toHaveBeenCalledTimes(3);
      if (kind === 'jobs') {
        expect(request.mock.calls.map(([, init]) => JSON.parse(init.body).cursor)).toEqual([
          undefined,
          'a',
          'b',
        ]);
      } else {
        expect(
          request.mock.calls.map(([path]) =>
            new URL(path, 'https://example.test').searchParams.get('cursor'),
          ),
        ).toEqual([null, 'a', 'b']);
      }
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      client.clear();
    }
  });
});
