import {
  QueryClient,
  QueryClientProvider,
  dehydrate,
  hydrate,
  onlineManager,
} from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import SubscribeScreen from '../../../app/(biglayout)/subscribe';
import SettingsBillingScreen from '../../../app/(app)/settings/billing';
import { BillingSection } from '../billing-section';
import { useChangePlan } from '@/lib/hooks/use-billing';
import { useBillingSession } from '@/lib/hooks/use-billing-session';

const state = vi.hoisted(() => {
  const state = {
    epoch: 0,
    actor: 'alice',
    authenticated: true,
    privateReady: true,
    token: 'test-token',
    post: vi.fn(),
    get: vi.fn(),
    open: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    replace: vi.fn(),
    accountDialog: vi.fn(),
    oxy: {
      http: { getSessionEpoch: () => 0, getAccessToken: () => 'test-token' as string | null },
    },
  };
  state.oxy = { http: { getSessionEpoch: () => state.epoch, getAccessToken: () => state.token } };
  return state;
});
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator',
  useWindowDimensions: () => ({ width: 800 }),
}));
vi.mock('expo-linking', () => ({ createURL: (s: string) => `test:${s}`, openURL: state.open }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: state.replace }),
  useLocalSearchParams: () => ({ success: 'true' }),
}));
vi.mock('expo-router/head', () => ({ default: 'Head' }));
vi.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    isAuthenticated: state.authenticated,
    isLoading: false,
    oxyServices: state.oxy,
  }),
  useOxy: () => ({
    isAuthenticated: state.authenticated,
    canUsePrivateApi: state.privateReady,
    user: { id: state.actor },
    openAccountDialog: state.accountDialog,
    oxyServices: state.oxy,
  }),
  OxySignInButton: 'SignIn',
}));
vi.mock('@/lib/api/use-api-client', () => ({
  useApiClient: () => ({ get: state.get, post: state.post }),
}));
vi.mock('@oxy.so/bloom/button', () => ({ Button: 'Button', GlyphButton: 'GlyphButton' }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { success: state.success, error: state.error } }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/settings/settings-header', () => ({ SettingsHeader: 'SettingsHeader' }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { primary: 'black' } }),
}));
vi.mock('@/lib/bloom-icon', () => ({ bloomIcon: () => () => null }));
vi.mock('lucide-react-native', () => ({
  ArrowLeft: 'ArrowLeft',
  Check: 'Check',
  Sparkles: 'Sparkles',
  CreditCard: 'CreditCard',
  Crown: 'Crown',
  ExternalLink: 'ExternalLink',
  Sparkle: 'Sparkle',
}));

beforeEach(() => {
  state.epoch = 0;
  state.actor = 'alice';
  state.authenticated = true;
  state.privateReady = true;
  state.token = 'test-token';
  state.post.mockReset();
  state.get.mockReset();
  state.get.mockImplementation(async (url: string) =>
    url.includes('/plans')
      ? { plans: [{ id: 'pro', name: 'Pro', monthlyPrice: 10 }] }
      : {
          subscription: {
            id: `sub-${state.actor}`,
            status: 'active',
            cancelAtPeriodEnd: false,
            currentPeriodEnd: '2027-01-01',
            plan: { name: 'Pro', price: 1000 },
          },
        },
  );
  state.open.mockReset();
  state.success.mockReset();
  state.error.mockReset();
  state.replace.mockReset();
  state.accountDialog.mockReset();
  state.oxy = { http: { getSessionEpoch: () => state.epoch, getAccessToken: () => state.token } };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

async function mount(kind: 'checkout' | 'billing') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 1 }, mutations: { retry: false } },
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        {kind === 'checkout' ? <SubscribeScreen /> : <BillingSection />}
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return { client, renderer };
}
function button(renderer: ReactTestRenderer, name: string) {
  const result = renderer.root
    .findAllByType('Button' as never)
    .find((item) => item.props.children === name);
  if (!result) throw new Error(`missing button ${name}`);
  return result.props.onPress as () => void;
}
async function close(renderer: ReactTestRenderer, client: QueryClient) {
  onlineManager.setOnline(true);
  await act(async () => renderer.unmount());
  client.clear();
}

it.each([
  { kind: 'checkout' as const, key: 'subscribe.subscribe' },
  { kind: 'billing' as const, key: 'billing.managePaymentMethods' },
])('does not open a late $kind URL from another session', async ({ kind, key }) => {
  let finish!: (v: { url: string }) => void;
  state.post.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { renderer, client } = await mount(kind);
  try {
    await act(async () => {
      void button(renderer, key)();
    });
    expect(state.post).toHaveBeenCalledTimes(1);
    state.epoch = 1;
    state.actor = 'bob';
    await act(async () => {
      finish({ url: 'https://billing.example/alice' });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(state.open).not.toHaveBeenCalled();
  } finally {
    await close(renderer, client);
  }
});

it.each([
  { kind: 'checkout' as const, key: 'subscribe.subscribe' },
  { kind: 'billing' as const, key: 'billing.managePaymentMethods' },
  { kind: 'billing' as const, key: 'billing.cancelSubscription' },
])('does not issue a paused $key under the next session', async ({ kind, key }) => {
  state.post.mockImplementation(async () => ({ actor: state.actor }));
  const { renderer, client } = await mount(kind);
  try {
    onlineManager.setOnline(false);
    await act(async () => {
      void button(renderer, key)();
    });
    expect(
      client
        .getMutationCache()
        .getAll()
        .some((m) => m.state.isPaused),
    ).toBe(true);
    state.epoch = 1;
    state.actor = 'bob';
    await act(async () => {
      onlineManager.setOnline(true);
      await client.resumePausedMutations();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(state.post).not.toHaveBeenCalled();
    expect(state.success).not.toHaveBeenCalled();
  } finally {
    await close(renderer, client);
  }
});

it.each([
  { kind: 'checkout' as const, key: 'subscribe.subscribe' },
  { kind: 'billing' as const, key: 'billing.managePaymentMethods' },
  { kind: 'billing' as const, key: 'billing.cancelSubscription' },
])('does not run a retained $key event from the old session', async ({ kind, key }) => {
  state.post.mockResolvedValue({});
  const { renderer, client } = await mount(kind);
  try {
    const retained = button(renderer, key);
    state.epoch = 1;
    state.actor = 'bob';
    await act(async () => {
      void retained();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(state.post).not.toHaveBeenCalled();
  } finally {
    await close(renderer, client);
  }
});

it.each([
  { kind: 'checkout' as const, key: 'subscribe.subscribe', path: '/billing/checkout/subscription' },
  { kind: 'billing' as const, key: 'billing.managePaymentMethods', path: '/billing/portal' },
  {
    kind: 'billing' as const,
    key: 'billing.cancelSubscription',
    path: '/billing/subscription/cancel',
  },
])('keeps $key working for the initiating session', async ({ kind, key, path }) => {
  state.post.mockResolvedValue({ url: 'https://billing.example/current' });
  const { renderer, client } = await mount(kind);
  try {
    await act(async () => {
      void button(renderer, key)();
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    expect(state.post).toHaveBeenCalledWith(path, expect.anything());
    if (key === 'billing.cancelSubscription')
      expect(state.success).toHaveBeenCalledWith('billing.cancelSubscriptionSuccess');
    else expect(state.open).toHaveBeenCalledWith('https://billing.example/current');
  } finally {
    await close(renderer, client);
  }
});

it.each(['resolve', 'reject'] as const)(
  'suppresses late cancel %s after an observed switch',
  async (outcome) => {
    let finish!: () => void;
    state.post.mockReturnValue(
      new Promise((resolve, reject) => {
        finish = () => (outcome === 'resolve' ? resolve({}) : reject(new Error('old error')));
      }),
    );
    const { renderer, client } = await mount('billing');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    try {
      await act(async () => {
        void button(renderer, 'billing.cancelSubscription')();
      });
      state.epoch = 1;
      await act(async () => {
        finish();
        await new Promise((resolve) => setTimeout(resolve, 15));
      });
      expect(state.success).not.toHaveBeenCalled();
      expect(state.error).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
    } finally {
      await close(renderer, client);
    }
  },
);

it('uses the new account subscription after a rerender and rejects the old retained event', async () => {
  state.post.mockResolvedValue({});
  const { renderer, client } = await mount('billing');
  try {
    const retained = button(renderer, 'billing.cancelSubscription');
    state.actor = 'bob';
    state.epoch = 1;
    await act(async () => {
      renderer.update(
        <QueryClientProvider client={client}>
          <BillingSection />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    await act(async () => {
      void retained();
      void button(renderer, 'billing.cancelSubscription')();
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    expect(state.post).toHaveBeenCalledTimes(1);
    expect(state.post).toHaveBeenCalledWith('/billing/subscription/cancel', {
      subscriptionId: 'sub-bob',
    });
  } finally {
    await close(renderer, client);
  }
});

it('suppresses a URL after unmount', async () => {
  let finish!: (v: { url: string }) => void;
  state.post.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { renderer, client } = await mount('checkout');
  try {
    await act(async () => {
      void button(renderer, 'subscribe.subscribe')();
    });
    await act(async () => renderer.unmount());
    await act(async () => {
      finish({ url: 'https://billing.example/old' });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(state.open).not.toHaveBeenCalled();
  } finally {
    onlineManager.setOnline(true);
    client.clear();
  }
});

it('suppresses an A-B-A completion using the real Core session epoch', async () => {
  const { OxyServices } = await import('@oxy.so/core');
  const oxy = new OxyServices({ baseURL: 'https://api.example.invalid' });
  const token = (sub: string, issued: number) =>
    `e30.${Buffer.from(JSON.stringify({ sub, sessionId: `session-${sub}`, iat: issued })).toString('base64url')}.signature`;
  oxy.http.setTokens(token('alice', 1));
  state.oxy = oxy;
  let finish!: (v: { url: string }) => void;
  state.post.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { renderer, client } = await mount('checkout');
  try {
    await act(async () => {
      void button(renderer, 'subscribe.subscribe')();
    });
    const epoch = oxy.http.getSessionEpoch();
    oxy.http.setTokens(token('alice', 2));
    expect(oxy.http.getSessionEpoch()).toBe(epoch);
    oxy.http.setTokens(token('bob', 1));
    oxy.http.setTokens(token('alice', 3));
    expect(oxy.http.getSessionEpoch()).toBeGreaterThan(epoch);
    await act(async () => {
      finish({ url: 'https://billing.example/old' });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(state.open).not.toHaveBeenCalled();
  } finally {
    await close(renderer, client);
    oxy.dispose();
  }
});

it('does not replay a JSON-restored paused mutation without its session check', async () => {
  const { renderer, client } = await mount('billing');
  const restored = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  try {
    onlineManager.setOnline(false);
    await act(async () => {
      void button(renderer, 'billing.cancelSubscription')();
    });
    const snapshot = JSON.parse(JSON.stringify(dehydrate(client)));
    expect(snapshot.mutations).toHaveLength(1);
    expect(snapshot.mutations[0].state.variables.isCurrent).toBeUndefined();
    await act(async () => renderer.unmount());
    hydrate(restored, snapshot);
    state.epoch = 1;
    await act(async () => {
      onlineManager.setOnline(true);
      await restored.resumePausedMutations();
    });
    expect(state.post).not.toHaveBeenCalled();
  } finally {
    onlineManager.setOnline(true);
    client.clear();
    restored.clear();
  }
});

it('cannot undo an already sent Core request, but does not open its late URL after a switch', async () => {
  const { OxyServices } = await import('@oxy.so/core');
  const oxy = new OxyServices({ baseURL: 'https://oxy.example.invalid' });
  const token = (sub: string) =>
    `e30.${Buffer.from(JSON.stringify({ sub, sessionId: `session-${sub}` })).toString('base64url')}.signature`;
  const aliceToken = token('alice');
  oxy.http.setTokens(aliceToken);
  state.oxy = oxy;
  const linked = oxy.createLinkedClient({ baseURL: 'https://clarity.example.invalid' });
  let respond!: (response: Response) => void;
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  state.post.mockImplementation((url, input) => linked.client.post(url, input));
  const { renderer, client } = await mount('checkout');
  try {
    await act(async () => {
      void button(renderer, 'subscribe.subscribe')();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((request[1].headers as Record<string, string>).Authorization).toBe(
      `Bearer ${aliceToken}`,
    );
    oxy.http.setTokens(token('bob'));
    await act(async () => {
      respond(
        new Response(JSON.stringify({ url: 'https://billing.example/old' }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.open).not.toHaveBeenCalled();
    expect(state.error).not.toHaveBeenCalled();
  } finally {
    await close(renderer, client);
    linked.dispose();
    oxy.dispose();
    vi.unstubAllGlobals();
  }
});

it('reports a failed offline-first request without silently queuing a retry', async () => {
  const { createRequire } = await import('node:module');
  const { dirname, join } = await import('node:path');
  const require = createRequire(import.meta.url);
  const servicesRoot = dirname(require.resolve('@oxy.so/services'));
  const { onlineManager: sdkOnline } = require(
    require.resolve('@tanstack/react-query', { paths: [servicesRoot] }),
  ) as { onlineManager: typeof onlineManager };
  const { createQueryClient } = require(join(servicesRoot, 'ui/hooks/queryClient.js')) as {
    createQueryClient: () => QueryClient & { __oxyOnlineUnsubscribe: () => void };
  };
  const client = createQueryClient();
  let renderer!: ReactTestRenderer;
  state.post.mockRejectedValue(new Error('offline'));
  try {
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={client}>
          <BillingSection />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    sdkOnline.setOnline(false);
    onlineManager.setOnline(false);
    await act(async () => {
      void button(renderer, 'billing.cancelSubscription')();
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    expect(state.post).toHaveBeenCalledTimes(1);
    expect(
      client
        .getMutationCache()
        .getAll()
        .some((m) => m.state.isPaused),
    ).toBe(false);
    expect(state.error).toHaveBeenCalledWith('offline');
  } finally {
    sdkOnline.setOnline(true);
    await close(renderer, client);
    client.__oxyOnlineUnsubscribe();
  }
});

it('rejects an event when a bearer disappears even before the view rerenders', async () => {
  state.post.mockResolvedValue({});
  const { renderer, client } = await mount('billing');
  try {
    const retained = button(renderer, 'billing.cancelSubscription');
    state.token = '';
    await act(async () => {
      void retained();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(state.post).not.toHaveBeenCalled();
  } finally {
    await close(renderer, client);
  }
});

it.each(['not-ready', 'new-projection', 'new-service'] as const)(
  'rejects old events after a %s render even if the epoch is unchanged',
  async (change) => {
    state.post.mockResolvedValue({});
    const { renderer, client } = await mount('billing');
    try {
      const retained = button(renderer, 'billing.cancelSubscription');
      if (change === 'not-ready') state.privateReady = false;
      if (change === 'new-projection') state.actor = 'bob';
      if (change === 'new-service')
        state.oxy = {
          http: { getSessionEpoch: () => state.epoch, getAccessToken: () => state.token },
        };
      await act(async () => {
        renderer.update(
          <QueryClientProvider client={client}>
            <BillingSection />
          </QueryClientProvider>,
        );
      });
      await act(async () => {
        void retained();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(state.post).not.toHaveBeenCalled();
    } finally {
      await close(renderer, client);
    }
  },
);

it('fences the unused change-plan hook when a paused mutation resumes in another session', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 1 }, mutations: { retry: false } },
  });
  function Probe() {
    const session = useBillingSession();
    const mutation = useChangePlan();
    return (
      <ButtonProbe
        onPress={() => {
          void mutation
            .mutateAsync({ planId: 'pro', billingPeriod: 'monthly', isCurrent: session.isCurrent })
            .catch(() => {});
        }}
      />
    );
  }
  const ButtonProbe = 'ButtonProbe' as unknown as React.ComponentType<{ onPress: () => void }>;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    onlineManager.setOnline(false);
    await act(async () => {
      renderer.root.findByType('ButtonProbe' as never).props.onPress();
    });
    expect(
      client
        .getMutationCache()
        .getAll()
        .some((m) => m.state.isPaused),
    ).toBe(true);
    state.epoch = 1;
    await act(async () => {
      onlineManager.setOnline(true);
      await client.resumePausedMutations();
    });
    expect(state.post).not.toHaveBeenCalled();
  } finally {
    await close(renderer, client);
  }
});

it('does not start private billing reads until the observed session is ready', async () => {
  state.privateReady = false;
  const { renderer, client } = await mount('billing');
  try {
    expect(state.get).not.toHaveBeenCalled();
    state.privateReady = true;
    await act(async () => {
      renderer.update(
        <QueryClientProvider client={client}>
          <BillingSection />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(state.get).toHaveBeenCalledWith('/billing/subscription');
  } finally {
    await close(renderer, client);
  }
});

it('separates account projections without storing user IDs or bearer tokens in query keys', async () => {
  state.post.mockResolvedValue({});
  const { renderer, client } = await mount('billing');
  try {
    state.actor = 'bob';
    await act(async () => {
      renderer.update(
        <QueryClientProvider client={client}>
          <BillingSection />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    await act(async () => {
      void button(renderer, 'billing.cancelSubscription')();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(state.post).toHaveBeenCalledWith('/billing/subscription/cancel', {
      subscriptionId: 'sub-bob',
    });
    const keys = JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    );
    expect(keys).not.toContain('alice');
    expect(keys).not.toContain('bob');
    expect(keys).not.toContain(state.token);
  } finally {
    await close(renderer, client);
  }
});

it.each([
  { kind: 'checkout' as const, key: 'subscribe.subscribe' },
  { kind: 'billing' as const, key: 'billing.managePaymentMethods' },
])('does not show late errors from a previous $kind session', async ({ kind, key }) => {
  let fail!: () => void;
  state.post.mockReturnValue(
    new Promise((_resolve, reject) => {
      fail = () => reject(new Error('old failure'));
    }),
  );
  const { renderer, client } = await mount(kind);
  try {
    await act(async () => {
      void button(renderer, key)();
    });
    state.epoch = 1;
    await act(async () => {
      fail();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(state.error).not.toHaveBeenCalled();
  } finally {
    await close(renderer, client);
  }
});

it('does not show the free plan while the authenticated session is not ready', async () => {
  state.privateReady = false;
  const { renderer, client } = await mount('billing');
  try {
    const texts = renderer.root.findAllByType('Text' as never).map((node) => node.props.children);
    expect(texts).not.toContain('billing.freePlan');
    expect(texts).toContain('billing.sessionPending');
    await act(async () => button(renderer, 'settings.account.title')());
    expect(state.accountDialog).toHaveBeenCalledTimes(1);
  } finally {
    await close(renderer, client);
  }
});

it('does not show an empty plan picker while the authenticated session is not ready', async () => {
  state.privateReady = false;
  const { renderer, client } = await mount('checkout');
  try {
    const texts = renderer.root.findAllByType('Text' as never).map((node) => node.props.children);
    expect(texts).toContain('billing.sessionPending');
    expect(texts).not.toContain('subscribe.heading');
  } finally {
    await close(renderer, client);
  }
});

it('does not attribute an unbound checkout return to a different session', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 1 }, mutations: { retry: false } },
  });
  let resolveOld!: (value: unknown) => void;
  let calls = 0;
  state.get.mockImplementation(async () => {
    calls++;
    if (calls === 1)
      return new Promise((resolve) => {
        resolveOld = resolve;
      });
    return {
      subscription: {
        id: `sub-${state.actor}`,
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: '2027-01-01',
        plan: { name: 'Pro', price: 1000 },
      },
    };
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={client}>
          <SettingsBillingScreen />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    expect(calls).toBe(1);
    const oldKey = client.getQueryCache().getAll()[0].queryKey;
    state.actor = 'bob';
    state.epoch = 1;
    await act(async () => {
      renderer.update(
        <QueryClientProvider client={client}>
          <SettingsBillingScreen />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      resolveOld({ subscription: { id: 'sub-alice', status: 'active' } });
      await new Promise((resolve) => setTimeout(resolve, 35));
    });
    expect(client.getQueryData(oldKey)).toBeUndefined();
    expect(state.success).not.toHaveBeenCalledWith('billing.paymentSuccess');
    expect(state.replace).not.toHaveBeenCalled();
    const texts = renderer.root.findAllByType('Text' as never).map((node) => node.props.children);
    expect(texts).toContain('billing.activeSubscription');
  } finally {
    await close(renderer, client);
  }
});

it.each(['billing', 'checkout'] as const)(
  'shows a retryable billing load error instead of a false plan (%s)',
  async (kind) => {
    state.get.mockRejectedValue(new Error('offline'));
    const { renderer, client } = await mount(kind);
    try {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
      const texts = renderer.root.findAllByType('Text' as never).map((node) => node.props.children);
      expect(texts).toContain('billing.loadError');
      expect(texts).not.toContain('billing.freePlan');
      state.get.mockImplementation(async (url: string) =>
        url.includes('/plans')
          ? { plans: [{ id: 'pro', name: 'Pro', monthlyPrice: 10 }] }
          : {
              subscription: {
                id: `sub-${state.actor}`,
                status: 'active',
                cancelAtPeriodEnd: false,
                currentPeriodEnd: '2027-01-01',
                plan: { name: 'Pro', price: 1000 },
              },
            },
      );
      await act(async () => {
        button(renderer, 'common.retry')();
        await new Promise((resolve) => setTimeout(resolve, 35));
      });
      const after = renderer.root.findAllByType('Text' as never).map((node) => node.props.children);
      expect(after).toContain(
        kind === 'billing' ? 'billing.activeSubscription' : 'subscribe.heading',
      );
    } finally {
      await close(renderer, client);
    }
  },
);

it('does not resume a paused billing read under a later session', async () => {
  onlineManager.setOnline(false);
  const { renderer, client } = await mount('billing');
  try {
    expect(state.get).not.toHaveBeenCalled();
    const oldKey = client.getQueryCache().getAll()[0].queryKey;
    state.epoch = 1;
    state.actor = 'bob';
    await act(async () => {
      onlineManager.setOnline(true);
      await new Promise((resolve) => setTimeout(resolve, 35));
    });
    expect(state.get).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(oldKey)).toBeUndefined();
    const active = client
      .getQueryCache()
      .getAll()
      .find((query) => (query.state.data as { id?: string } | undefined)?.id === 'sub-bob');
    expect(active).toBeDefined();
  } finally {
    await close(renderer, client);
  }
});

it.each([false, true])(
  'retries an offline-first read only for its still-current session (switch: %s)',
  async (changed) => {
    const { createRequire } = await import('node:module');
    const { dirname, join } = await import('node:path');
    const require = createRequire(import.meta.url);
    const servicesRoot = dirname(require.resolve('@oxy.so/services'));
    const { onlineManager: sdkOnline } = require(
      require.resolve('@tanstack/react-query', { paths: [servicesRoot] }),
    ) as { onlineManager: typeof onlineManager };
    const { createQueryClient } = require(join(servicesRoot, 'ui/hooks/queryClient.js')) as {
      createQueryClient: () => QueryClient & { __oxyOnlineUnsubscribe: () => void };
    };
    const client = createQueryClient();
    const defaults = client.getDefaultOptions();
    client.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retryDelay: 1 } });
    state.get.mockRejectedValueOnce(new Error('offline'));
    sdkOnline.setOnline(false);
    onlineManager.setOnline(false);
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(
          <QueryClientProvider client={client}>
            <BillingSection />
          </QueryClientProvider>,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      expect(state.get).toHaveBeenCalledTimes(1);
      const originalQuery = client.getQueryCache().getAll()[0];
      expect(originalQuery.state.fetchStatus).toBe('paused');
      if (changed) {
        state.actor = 'bob';
        state.epoch = 1;
      }
      await act(async () => {
        sdkOnline.setOnline(true);
        onlineManager.setOnline(true);
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
      expect(state.get).toHaveBeenCalledTimes(2);
      if (changed) expect(originalQuery.state.data).toBeUndefined();
      else expect(originalQuery.state.data).toMatchObject({ id: 'sub-alice' });
      const texts = renderer.root.findAllByType('Text' as never).map((node) => node.props.children);
      expect(texts).toContain('billing.activeSubscription');
    } finally {
      sdkOnline.setOnline(true);
      await close(renderer, client);
      client.__oxyOnlineUnsubscribe();
    }
  },
);

it('refreshes a current subscription after a delayed webhook without claiming payment success', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 1 }, mutations: { retry: false } },
  });
  let firstResponse!: (value: unknown) => void;
  let calls = 0;
  state.get.mockImplementation(async () => {
    calls++;
    if (calls === 1)
      return new Promise((resolve) => {
        firstResponse = resolve;
      });
    return {
      subscription: {
        id: 'sub-alice',
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: '2027-01-01',
        plan: { name: 'Pro', price: 1000 },
      },
    };
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={client}>
          <SettingsBillingScreen />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      firstResponse({ subscription: null });
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    let texts = renderer.root.findAllByType('Text' as never).map((node) => node.props.children);
    expect(texts).toContain('billing.checkingStatus');
    expect(texts).not.toContain('billing.freePlan');
    expect(state.success).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2100));
    });
    texts = renderer.root.findAllByType('Text' as never).map((node) => node.props.children);
    expect(calls).toBe(2);
    expect(texts).toContain('billing.activeSubscription');
    expect(state.success).not.toHaveBeenCalled();
    expect(state.replace).not.toHaveBeenCalled();
  } finally {
    await close(renderer, client);
  }
}, 5000);

it('stops the return refresh after its bounded attempts and offers a manual refresh', async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 1 }, mutations: { retry: false } },
  });
  state.get.mockResolvedValue({ subscription: null });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={client}>
          <SettingsBillingScreen />
        </QueryClientProvider>,
      );
      await vi.advanceTimersByTimeAsync(20);
    });
    for (let index = 0; index < 16; index++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
    }
    const count = state.get.mock.calls.length;
    expect(count).toBeLessThanOrEqual(16);
    expect(count).toBeGreaterThanOrEqual(15);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(state.get).toHaveBeenCalledTimes(count);
    const texts = renderer.root.findAllByType('Text' as never).map((node) => node.props.children);
    expect(texts).toContain('billing.checkStatusHint');
    expect(texts).toContain('billing.freePlan');
    await act(async () => {
      button(renderer, 'common.retry')();
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(state.get).toHaveBeenCalledTimes(count + 1);
    expect(state.success).not.toHaveBeenCalled();
  } finally {
    await act(async () => renderer.unmount());
    client.clear();
    vi.useRealTimers();
  }
});

it('stops the old account return refresh when another account becomes active', async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 1 }, mutations: { retry: false } },
  });
  const requestedBy: string[] = [];
  state.get.mockImplementation(async () => {
    requestedBy.push(state.actor);
    return {
      subscription:
        state.actor === 'alice'
          ? null
          : {
              id: 'sub-bob',
              status: 'active',
              cancelAtPeriodEnd: false,
              currentPeriodEnd: '2027-01-01',
              plan: { name: 'Pro', price: 1000 },
            },
    };
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={client}>
          <SettingsBillingScreen />
        </QueryClientProvider>,
      );
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(requestedBy).toEqual(['alice']);
    state.actor = 'bob';
    state.epoch = 1;
    await act(async () => {
      renderer.update(
        <QueryClientProvider client={client}>
          <SettingsBillingScreen />
        </QueryClientProvider>,
      );
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(requestedBy).toEqual(['alice', 'bob']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(requestedBy).toEqual(['alice', 'bob']);
    const texts = renderer.root.findAllByType('Text' as never).map((node) => node.props.children);
    expect(texts).toContain('billing.activeSubscription');
    expect(state.success).not.toHaveBeenCalled();
  } finally {
    await act(async () => renderer.unmount());
    client.clear();
    vi.useRealTimers();
  }
});

it('does not label a trialing subscription as free after a return', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  state.get.mockResolvedValue({
    subscription: {
      id: 'trial',
      status: 'trialing',
      cancelAtPeriodEnd: false,
      currentPeriodEnd: '2027-01-01',
      plan: { name: 'Pro', price: 1000 },
    },
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={client}>
          <SettingsBillingScreen />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const texts = renderer.root.findAllByType('Text' as never).map((node) => node.props.children);
    expect(texts).toContain('billing.activeSubscription');
    expect(texts).not.toContain('billing.freePlan');
    expect(state.success).not.toHaveBeenCalled();
  } finally {
    await close(renderer, client);
  }
});
