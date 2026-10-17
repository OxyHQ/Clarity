import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import { useApiClient } from '../api/use-api-client';
import { queryKeys } from './query-keys';

export interface PlanFeatureItem {
  label: string;
  description?: string;
}

export interface PlanFeatureGroup {
  category: string;
  items: PlanFeatureItem[];
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  product: 'clarity' | 'codea';
  creditsPerMonth: number;
  monthlyPrice: number;
  annualPrice: number;
  currency: string;
  features?: PlanFeatureGroup[];
  subtitle?: string;
  creditsLabel?: string;
  isFeatured?: boolean;
  isFree?: boolean;
  sortOrder?: number;
}

export interface Subscription {
  id: string;
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  status: 'active' | 'canceled' | 'past_due' | 'unpaid' | 'trialing';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  plan: {
    planId?: string;
    name: string;
    product: 'clarity' | 'codea';
    creditsPerMonth: number;
    price: number;
    currency: string;
    billingPeriod?: 'monthly' | 'annual';
  };
  createdAt: string;
  updatedAt: string;
}

// ======================
// Subscription Plans
// ======================

export function useSubscriptionPlans(product?: 'clarity' | 'codea') {
  const { isAuthenticated } = useOxy();
  const client = useApiClient();

  return useQuery({
    queryKey: queryKeys.billing.plans(product),
    queryFn: async () => {
      const params = product ? `?product=${product}` : '';
      const data = await client.get<{ plans: SubscriptionPlan[] }>(`/billing/plans${params}`);
      return data.plans;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 2,
    enabled: isAuthenticated,
  });
}

// ======================
// Current Subscription
// ======================

export function useSubscription(product?: 'clarity' | 'codea') {
  const { isAuthenticated } = useOxy();
  const client = useApiClient();

  return useQuery({
    queryKey: queryKeys.billing.subscription(product),
    queryFn: async () => {
      const params = product ? `?product=${product}` : '';
      const data = await client.get<{ subscription: Subscription | null }>(
        `/billing/subscription${params}`,
      );
      return data.subscription;
    },
    staleTime: 1000 * 60 * 2, // 2 minutes
    retry: 2,
    enabled: isAuthenticated,
  });
}

// ======================
// Subscription Polling (after checkout redirect)
// ======================

/**
 * Polls for subscription until it exists and is active, or timeout.
 * Used after checkout redirect to wait for webhook processing.
 */
export function useSubscriptionPolling(
  product?: 'clarity' | 'codea',
  options?: { enabled?: boolean; intervalMs?: number; maxAttempts?: number },
) {
  const { enabled = false, intervalMs = 2000, maxAttempts = 15 } = options || {};
  const client = useApiClient();

  return useQuery({
    queryKey: queryKeys.billing.subscriptionPoll(product),
    queryFn: async () => {
      const params = product ? `?product=${product}` : '';
      const data = await client.get<{ subscription: Subscription | null }>(
        `/billing/subscription${params}`,
      );
      return data.subscription;
    },
    enabled,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && (data.status === 'active' || data.status === 'trialing')) {
        return false;
      }
      if (query.state.dataUpdateCount >= maxAttempts) {
        return false;
      }
      return intervalMs;
    },
    staleTime: 0,
    retry: 1,
  });
}

export function useCreateSubscriptionCheckout() {
  const client = useApiClient();
  return useMutation({
    mutationFn: ({
      planId,
      billingPeriod,
      successUrl,
      cancelUrl,
    }: {
      planId: string;
      billingPeriod: 'monthly' | 'annual';
      successUrl: string;
      cancelUrl: string;
    }) =>
      client.post<{ url: string }>('/billing/checkout/subscription', {
        planId,
        billingPeriod,
        successUrl,
        cancelUrl,
      }),
  });
}

export function useChangePlan() {
  const queryClient = useQueryClient();
  const client = useApiClient();
  return useMutation({
    mutationFn: ({
      planId,
      billingPeriod,
    }: {
      planId: string;
      billingPeriod: 'monthly' | 'annual';
    }) =>
      client.post<{ subscription: Subscription; direction: 'upgrade' | 'downgrade' }>(
        '/billing/subscription/change-plan',
        { planId, billingPeriod },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.billing.subscriptions });
    },
  });
}

export function useCancelSubscription() {
  const queryClient = useQueryClient();
  const client = useApiClient();
  return useMutation({
    mutationFn: (input?: { subscriptionId: string }) =>
      client.post('/billing/subscription/cancel', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.billing.subscriptions });
    },
  });
}

export function useCreatePortalSession() {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (returnUrl: string) => {
      const data = await client.post<{ url: string }>('/billing/portal', { returnUrl });
      return data.url;
    },
  });
}
