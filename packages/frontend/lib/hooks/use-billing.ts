import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '../api/use-api-client';
import { queryKeys } from './query-keys';
import {
  useBillingSession,
  requireBillingSession,
  type BillingSessionCheck,
} from './use-billing-session';

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
  const client = useApiClient();
  const session = useBillingSession();

  return useQuery({
    queryKey: [...queryKeys.billing.plans(product), ...session.cacheKey],
    queryFn: async () => {
      const params = product ? `?product=${product}` : '';
      const data = await client.get<{ plans: SubscriptionPlan[] }>(`/billing/plans${params}`);
      return data.plans;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 2,
    enabled: session.ready,
  });
}

// ======================
// Current Subscription
// ======================

export function useSubscription(product?: 'clarity' | 'codea') {
  const client = useApiClient();
  const session = useBillingSession();

  return useQuery({
    queryKey: [...queryKeys.billing.subscription(product), ...session.cacheKey],
    queryFn: async () => {
      const params = product ? `?product=${product}` : '';
      const data = await client.get<{ subscription: Subscription | null }>(
        `/billing/subscription${params}`,
      );
      return data.subscription;
    },
    staleTime: 1000 * 60 * 2, // 2 minutes
    retry: 2,
    enabled: session.ready,
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
  const session = useBillingSession();

  return useQuery({
    queryKey: [...queryKeys.billing.subscriptionPoll(product), ...session.cacheKey],
    queryFn: async () => {
      const params = product ? `?product=${product}` : '';
      const data = await client.get<{ subscription: Subscription | null }>(
        `/billing/subscription${params}`,
      );
      return data.subscription;
    },
    enabled: enabled && session.ready,
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
      isCurrent,
    }: {
      planId: string;
      billingPeriod: 'monthly' | 'annual';
      successUrl: string;
      cancelUrl: string;
      isCurrent: BillingSessionCheck;
    }) => {
      requireBillingSession(isCurrent);
      return client.post<{ url: string }>('/billing/checkout/subscription', {
        planId,
        billingPeriod,
        successUrl,
        cancelUrl,
      });
    },
  });
}

export function useChangePlan() {
  const queryClient = useQueryClient();
  const client = useApiClient();
  return useMutation({
    mutationFn: ({
      planId,
      billingPeriod,
      isCurrent,
    }: {
      planId: string;
      billingPeriod: 'monthly' | 'annual';
      isCurrent: BillingSessionCheck;
    }) => {
      requireBillingSession(isCurrent);
      return client.post<{ subscription: Subscription; direction: 'upgrade' | 'downgrade' }>(
        '/billing/subscription/change-plan',
        { planId, billingPeriod },
      );
    },
    onSuccess: (_data, { isCurrent }) => {
      if (isCurrent())
        void queryClient.invalidateQueries({ queryKey: queryKeys.billing.subscriptions });
    },
  });
}

export function useCancelSubscription() {
  const queryClient = useQueryClient();
  const client = useApiClient();
  return useMutation({
    mutationFn: ({
      input,
      isCurrent,
    }: {
      input?: { subscriptionId: string };
      isCurrent: BillingSessionCheck;
    }) => {
      requireBillingSession(isCurrent);
      return client.post('/billing/subscription/cancel', input);
    },
    onSuccess: (_data, { isCurrent }) => {
      if (isCurrent())
        void queryClient.invalidateQueries({ queryKey: queryKeys.billing.subscriptions });
    },
  });
}

export function useCreatePortalSession() {
  const client = useApiClient();
  return useMutation({
    mutationFn: async ({
      returnUrl,
      isCurrent,
    }: {
      returnUrl: string;
      isCurrent: BillingSessionCheck;
    }) => {
      requireBillingSession(isCurrent);
      const data = await client.post<{ url: string }>('/billing/portal', { returnUrl });
      return data.url;
    },
  });
}
