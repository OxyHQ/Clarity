import { useQuery } from '@tanstack/react-query';

import type { NewsResponse } from '@clarity/shared-types';

import { requestPublicApi } from '../api/public-request';
import { queryKeys } from './query-keys';

/**
 * The stories behind Discover, from Clarity's public `/news` surface — no
 * session, like Jobs and the market quotes: reading the news identifies no one.
 * In the reader's languages; the server falls back to every language when
 * those have no news yet.
 */
export function useNews(languages: readonly string[], limit = 30) {
  const filter = languages.length ? `&languages=${encodeURIComponent(languages.join(','))}` : '';
  return useQuery({
    queryKey: queryKeys.news.list(limit, languages),
    queryFn: ({ signal }) => requestPublicApi<NewsResponse>(`/news?limit=${limit}${filter}`, { method: 'GET', signal }),
    staleTime: 5 * 60_000,
  });
}
