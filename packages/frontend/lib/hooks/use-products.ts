import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import type { ProductDetail, ProductSearchResponse } from '@clarity/shared-types';

import { requestPublicApi } from '../api/public-request';
import { shouldRetryProductRequest } from '../products-format';
import { queryKeys } from './query-keys';

/** How many products one page of results asks for (the backend allows 1–50). */
export const PRODUCT_PAGE_SIZE = 20;

/**
 * Shopping is a public read surface answered by Mercaria: these calls carry no
 * session and no user identity. Results come back in Mercaria's order and are
 * rendered in it — nothing here sorts.
 *
 * Disabled until there is a query: the backend requires 1–200 characters.
 */
export function useProductSearch(query: string, market?: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.products.search(query, market),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ q: query, limit: String(PRODUCT_PAGE_SIZE) });
      if (market) params.set('market', market);
      // The cursor is opaque: passed back verbatim, with the same query.
      if (pageParam) params.set('cursor', pageParam);
      return requestPublicApi<ProductSearchResponse>(`/products/search?${params.toString()}`, {
        method: 'GET',
        signal,
      });
    },
    getNextPageParam: (lastPage: ProductSearchResponse) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    retry: shouldRetryProductRequest,
    staleTime: 60_000,
    enabled: query.length > 0,
  });
}

export function useProduct(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.products.detail(id ?? ''),
    queryFn: ({ signal }) =>
      requestPublicApi<ProductDetail>(`/products/${encodeURIComponent(id ?? '')}`, {
        method: 'GET',
        signal,
      }),
    enabled: Boolean(id),
    retry: shouldRetryProductRequest,
    staleTime: 60_000,
  });
}
