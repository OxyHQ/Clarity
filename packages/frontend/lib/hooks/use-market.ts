import { useQuery } from '@tanstack/react-query';

import type { MarketQuotesResponse } from '@clarity/shared-types';

import { requestPublicApi } from '../api/public-request';
import { queryKeys } from './query-keys';

/**
 * The quotes behind the Finance page's crypto cards.
 *
 * One request for the whole row rather than one per card: the surface is
 * rate-limited by address, and four requests per page view would spend a
 * visitor's burst allowance on a single screen. Each asset still gets its own
 * outcome in the response, so an upstream that is down for FairCoin does not
 * take Bitcoin off the page.
 *
 * Refetched on the same minute the backend caches for — the quote a reader is
 * looking at is never more than about a minute old, and `updatedAt` on every
 * card says exactly how old it is.
 */
export function useMarketQuotes(assets: readonly string[]) {
  return useQuery({
    queryKey: queryKeys.market.quotes(assets),
    queryFn: ({ signal }) => requestPublicApi<MarketQuotesResponse>(
      `/market/quotes?assets=${encodeURIComponent(assets.join(','))}`,
      { method: 'GET', signal },
    ),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
