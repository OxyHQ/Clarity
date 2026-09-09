import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';

import type { JobPosting, JobReportRequest, JobSearchRequest, JobSearchResponse } from '@clarity/shared-types';

import { requestPublicApi } from '../api/public-request';
import { queryKeys } from './query-keys';

/**
 * Clarity Jobs is a public read surface: these calls carry no session and no
 * user identity, which is what keeps searching or opening a listing invisible
 * to the employer.
 */
export function useJobSearch(request: JobSearchRequest, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.jobs.search(request),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => requestPublicApi<JobSearchResponse>('/jobs/search', {
      method: 'POST',
      body: JSON.stringify({ ...request, ...(pageParam ? { cursor: pageParam } : {}) }),
      signal,
    }),
    getNextPageParam: (lastPage: JobSearchResponse) => lastPage.nextCursor,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    enabled,
  });
}

export function useJobPosting(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.jobs.detail(id ?? ''),
    queryFn: ({ signal }) => requestPublicApi<JobPosting>(`/jobs/${encodeURIComponent(id ?? '')}`, { method: 'GET', signal }),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

/**
 * Report a listing. The request carries no identity, and Clarity treats a
 * report as an operator signal — it never changes where a listing ranks.
 */
export function useReportJobPosting(id: string | undefined) {
  return useMutation({
    mutationFn: (request: JobReportRequest) => requestPublicApi<{ status: string }>(
      `/jobs/${encodeURIComponent(id ?? '')}/report`,
      { method: 'POST', body: JSON.stringify(request) },
    ),
  });
}
