import { useQuery } from '@tanstack/react-query';

import type { NewsResponse } from '@clarity/shared-types';

import { requestPublicApi } from '../api/public-request';
import { queryKeys } from './query-keys';

/**
 * The stories behind Discover, from Clarity's public `/news` surface — no
 * session, like Jobs and the market quotes: reading the news identifies no one.
 */
export function useNews(limit = 30) {
  return useQuery({
    queryKey: queryKeys.news.list(limit),
    queryFn: ({ signal }) => requestPublicApi<NewsResponse>(`/news?limit=${limit}`, { method: 'GET', signal }),
    staleTime: 5 * 60_000,
  });
}
