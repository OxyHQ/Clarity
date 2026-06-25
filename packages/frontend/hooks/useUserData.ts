import { useEffect } from 'react';
import { useAuth } from '@oxyhq/services';
import { useUserDataStore } from '@/lib/stores/user-data-store';
import type { UserMemory } from '@/lib/stores/user-data-store';
import { useApiClient } from '@/lib/api/use-api-client';

// NOTE: This hook calls /memory which is a dead backend endpoint.
// It is kept as-is (with shape migrated to the linked client) because
// security-section and personalization-section render this data via the store.
// The dead endpoint means this fetch will always fail silently.
// FLAG: live UI (security-section, personalization-section) reads memory from a dead backend route.
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
