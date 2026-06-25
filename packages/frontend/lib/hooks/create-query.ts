import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { useApiClient } from '../api/use-api-client';

/** Authenticated GET query — wraps the repeated useOxy + useQuery pattern. */
export function useAuthQuery<T>(
  queryKey: readonly unknown[],
  url: string,
  params?: Record<string, unknown>,
  options?: Partial<UseQueryOptions<T>>,
) {
  const { isAuthenticated } = useOxy();
  const client = useApiClient();
  return useQuery<T>({
    queryKey,
    queryFn: async () => {
      const data = await client.get<T>(url, params ? { params } : undefined);
      return data;
    },
    staleTime: 1000 * 60 * 5,
    retry: 2,
    enabled: isAuthenticated,
    ...options,
  });
}
