import { useEffect } from 'react';
import { useAuth } from '@oxyhq/services';
import { useUserDataStore } from '@/lib/stores/user-data-store';
import type { UserMemory } from '@/lib/stores/user-data-store';
import { useApiClient } from '@/lib/api/use-api-client';

// Memory is owned by Alia and exposed through Clarity's authenticated,
// allowlisted product proxy.
export function useUserData() {
  const { isAuthenticated } = useAuth();
  const { memory, loading, setMemory, setLoading, shouldRefetch, clearMemory } = useUserDataStore();
  const client = useApiClient();

  useEffect(() => {
    // Clear data if not authenticated
    if (!isAuthenticated) {
      clearMemory();
      return;
    }

    // Only fetch if we should refetch (cache expired or no data)
    if (!shouldRefetch() && memory) {
      return;
    }

    const fetchUserData = async () => {
      setLoading(true);
      try {
        const data = await client.get<UserMemory>('/memory');
        if (data) {
          setMemory(data);
        }
      } catch (error) {
        console.error('Error fetching user data:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchUserData();
  }, [isAuthenticated, shouldRefetch]);

  return {
    memory,
    loading,
    refetch: () => {
      clearMemory();
      // This will trigger the useEffect to fetch again
    },
  };
}
