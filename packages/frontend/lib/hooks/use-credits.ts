import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { useApiClient } from '../api/use-api-client';
import { queryKeys } from './query-keys';
import { useAuthQuery } from './create-query';

// --- Shared period type ---

export type UsagePeriod = '24h' | '48h' | '72h' | '7d';

export const PERIODS: UsagePeriod[] = ['24h', '48h', '72h', '7d'];

const PERIOD_DAYS: Record<UsagePeriod, number> = {
  '24h': 1,
  '48h': 2,
  '72h': 3,
  '7d': 7,
};

// --- Credits ---

export interface CreditsInfo {
  credits: number;
  freeCredits: number;
  freeLimit: number;
  paidCredits: number;
  dailyRefresh: number;
  lastRefresh: string;
}

export function useCredits() {
  return useAuthQuery<CreditsInfo>(queryKeys.credits.info, '/credits', undefined, { staleTime: 60_000 });
}

// --- Credit usage chart ---

export interface DailyUsage {
  date: string;
  used: number;
}

export function useCreditsUsage(period: UsagePeriod = '24h') {
  return useAuthQuery<DailyUsage[]>(queryKeys.credits.usage(period), '/credits/usage', { period }, { staleTime: 30_000 });
}

// --- Analytics ---

export interface UsageDay {
  _id: string;
  conversations: number;
  totalTokens: number;
}

export interface ModelUsage {
  _id: string;
  name: string;
  emoji?: string;
  count: number;
  totalTokens: number;
}

interface AnalyticsData {
  usage: UsageDay[];
  models: ModelUsage[];
}

export function useAnalytics(period: UsagePeriod = '24h') {
  const days = PERIOD_DAYS[period];
  const { isAuthenticated } = useOxy();
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.credits.analytics(period),
    queryFn: async () => {
      const [u, m] = await Promise.all([
        client.get<{ usage: UsageDay[] }>('/analytics/usage', { params: { days } }),
        client.get<{ models: ModelUsage[] }>('/analytics/models', { params: { days } }),
      ]);
      return { usage: u.usage, models: m.models } as AnalyticsData;
    },
    staleTime: 60_000,
    retry: 2,
    enabled: isAuthenticated,
  });
}
