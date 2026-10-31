import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { getNextOrganizationPage } from '../organization-pagination';

describe('organization directory pagination', () => {
  it.each([
    { cursors: ['a', 'a'], expectedRequests: [undefined, 'a'] },
    { cursors: ['a', 'b', 'a'], expectedRequests: [undefined, 'a', 'b'] },
    { cursors: [''], expectedRequests: [undefined] },
    { cursors: [null], expectedRequests: [undefined] },
  ])(
    'stops on a missing or previously visited cursor: $cursors',
    async ({ cursors, expectedRequests }) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      let index = 0;
      const queryFn = vi.fn(async (_context: { pageParam: string | undefined }) => ({
        items: [],
        nextCursor: cursors[index++] ?? null,
      }));
      const observer = new InfiniteQueryObserver(client, {
        queryKey: ['organizations', 'search', 'example'],
        initialPageParam: undefined as string | undefined,
        queryFn,
        getNextPageParam: getNextOrganizationPage,
      });
      await observer.refetch();
      let result = observer.getCurrentResult();
      for (let i = 0; i < 4 && result.hasNextPage; i++) {
        result = await observer.fetchNextPage();
      }
      expect(queryFn.mock.calls.map(([{ pageParam }]) => pageParam)).toEqual(expectedRequests);
      expect(result.hasNextPage).toBe(false);
      client.clear();
    },
  );

  it('tracks cursors separately for each query identity', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const queryFn = vi.fn(async () => ({ items: [], nextCursor: 'a' }));
    const options = {
      initialPageParam: undefined as string | undefined,
      queryFn,
      getNextPageParam: getNextOrganizationPage,
    };
    const first = new InfiniteQueryObserver(client, {
      ...options,
      queryKey: ['organizations', 'search', 'first', 'session-a'],
    });
    await first.refetch();
    expect((await first.fetchNextPage()).hasNextPage).toBe(false);
    const second = new InfiniteQueryObserver(client, {
      ...options,
      queryKey: ['organizations', 'search', 'second', 'session-b'],
    });
    await second.refetch();
    expect(second.getCurrentResult().hasNextPage).toBe(true);
    client.clear();
  });
});
