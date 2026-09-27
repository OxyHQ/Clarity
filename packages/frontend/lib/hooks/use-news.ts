import { useQuery } from '@tanstack/react-query';

import type { NewsResponse } from '@clarity/shared-types';

import { requestPublicApi } from '../api/public-request';
import { queryKeys } from './query-keys';

/**
 * The stories behind Discover, from Clarity's public `/news` surface — no
 * session, like Jobs and the market quotes: reading the news identifies no one.
 *
 * Asks for the reader's languages first. A feed with nothing in them falls
 * back to every language rather than showing an empty page.
 */
export function useNews(languages: readonly string[], limit = 30) {
  return useQuery({
    queryKey: queryKeys.news.list(limit, languages),
    queryFn: async ({ signal }) => {
      const request = (filter: string) =>
        requestPublicApi<NewsResponse>(`/news?limit=${limit}${filter}`, { method: 'GET', signal });
      if (languages.length === 0) return request('');
      const inReaderLanguages = await request(`&languages=${encodeURIComponent(languages.join(','))}`);
      return inReaderLanguages.data.length > 0 ? inReaderLanguages : request('');
    },
    staleTime: 5 * 60_000,
  });
}
