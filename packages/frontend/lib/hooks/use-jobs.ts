import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';

import type { JobPosting, JobReportRequest, JobSearchRequest, JobSearchResponse } from '@clarity/shared-types';

import config from '../config';
import { queryKeys } from './query-keys';

/**
 * Clarity Jobs is a public read surface: these calls carry no session and no
 * user identity, which is what keeps searching or opening a listing invisible
 * to the employer.
 */
async function requestJobs<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
    throw new Error(body?.error?.message ?? `Clarity Jobs request failed with ${response.status}`);
  }
  return await response.json() as T;
}

export function useJobSearch(request: JobSearchRequest, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.jobs.search(request),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => requestJobs<JobSearchResponse>('/jobs/search', {
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
    queryFn: ({ signal }) => requestJobs<JobPosting>(`/jobs/${encodeURIComponent(id ?? '')}`, { method: 'GET', signal }),
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
    mutationFn: (request: JobReportRequest) => requestJobs<{ status: string }>(
      `/jobs/${encodeURIComponent(id ?? '')}/report`,
      { method: 'POST', body: JSON.stringify(request) },
    ),
  });
}
