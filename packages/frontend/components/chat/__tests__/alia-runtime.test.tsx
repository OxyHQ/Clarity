import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import { ClarityChatRuntime } from '../clarity-chat-runtime';
import { useChatConversation } from '../../../hooks/useChatConversation';

const fixture = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; method: string; body?: string }>,
  navigate: vi.fn(),
  holdStream: false,
  replyToStop: undefined as ((response: Response) => void) | undefined,
  onTurnDisposed: undefined as (() => void) | undefined,
}));

// Use the installed runtime implementation without loading the root entry's native UI graph.
vi.mock('@alia.onl/sdk', async () => {
  const runtime =
    await vi.importActual<typeof import('@alia.onl/sdk/runtime')>('@alia.onl/sdk/runtime');
  return {
    ...runtime,
    AliaChatLabelsProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@oxy.so/services/ui/client', () => {
  const oxyServices = {
    createLinkedClient: () => {
      let isTurn = false;
      return {
        client: {
          getSessionEpoch: () => 0,
          addTokenChangeListener: () => () => {},
          requestAuthenticatedResponse: async (request: {
            url: string;
            method: string;
            body?: string;
            signal?: AbortSignal;
          }) => {
            fixture.requests.push(request);
            if (request.method === 'GET' && /^\/v1\/conversations\/chat-[12]$/.test(request.url)) {
              return Response.json({
                id: request.url.split('/').at(-1),
                messages: [],
                createdAt: 0,
                updatedAt: 0,
              });
            }
            if (request.method === 'POST' && request.url === '/v1/conversations/new') {
              return Response.json({ id: 'chat-1', title: 'Chat', createdAt: 0, updatedAt: 0 });
            }
            if (request.method === 'POST' && request.url === '/v1/chat/completions') {
              isTurn = true;
              if (fixture.holdStream) {
                return new Response(
                  new ReadableStream({
                    start(controller) {
                      request.signal?.addEventListener(
                        'abort',
                        () => controller.error(new DOMException('Aborted', 'AbortError')),
                        { once: true },
                      );
                    },
                  }),
                );
              }
              return new Response(
                'data: {"choices":[{"delta":{"content":"Hello from Alia"}}]}\n\ndata: [DONE]\n\n',
                {
                  headers: { 'Content-Type': 'text/event-stream' },
                },
              );
            }
            if (
              request.method === 'POST' &&
              /^\/v1\/chat\/turns\/[^/]+\/cancel$/.test(request.url)
            ) {
              return new Promise<Response>((resolve) => {
                fixture.replyToStop = resolve;
              });
            }
            throw new Error(`Unexpected request: ${request.method} ${request.url}`);
          },
        },
        dispose: () => {
          if (isTurn) fixture.onTurnDisposed?.();
        },
      };
    },
  };
  return {
    useOxy: () => ({ oxyServices, user: { id: 'user-1' }, isAuthenticated: true }),
    useAppAssertion: () => ({ getAppAssertionHeaders: async () => ({}) }),
  };
});
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: fixture.navigate }) }));
vi.mock('@/hooks/useClarityChat', () => ({
  useClarityChatLabels: () => ({}),
  useFeatureLockedHandler: () => vi.fn(),
}));
vi.mock('@/lib/stores/power-level-store', () => ({
  usePowerLevelStore: (selector: (state: { powerLevel: string }) => unknown) =>
    selector({ powerLevel: 'auto' }),
}));
vi.mock('@/lib/globalStore', () => ({
  useStore: { getState: () => ({ webSearchMode: false, deepResearchMode: true }) },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'web', select: (values: { web?: unknown }) => values.web },
}));

beforeEach(() => {
  fixture.requests.length = 0;
  fixture.navigate.mockReset();
  fixture.holdStream = false;
  fixture.replyToStop = undefined;
  fixture.onTurnDisposed = undefined;
});

it('keeps a delayed Stop failure out of the replacement conversation', async () => {
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  });
  fixture.holdStream = true;
  const turnDisposed = new Promise<void>((resolve) => {
    fixture.onTurnDisposed = resolve;
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let thread!: ReturnType<typeof useChatConversation>;
  function Probe({ conversationId }: { conversationId: string }) {
    thread = useChatConversation({ conversationId });
    return null;
  }
  let renderer!: ReactTestRenderer;
  function tree(id: string) {
    return (
      <QueryClientProvider client={queryClient}>
        <ClarityChatRuntime conversationId={id}>
          <Probe conversationId={id} />
        </ClarityChatRuntime>
      </QueryClientProvider>
    );
  }
  await act(async () => {
    renderer = create(tree('chat-1'));
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(queryClient.getQueryState(['conversation', 'chat-1'])?.status).toBe('success'),
    );
  });
  await act(async () => {
    thread.sendMessage('First');
    await vi.waitFor(() =>
      expect(fixture.requests.some((r) => r.url === '/v1/chat/completions')).toBe(true),
    );
  });
  await act(async () => {
    thread.stopGeneration();
    thread.stopGeneration();
    await vi.waitFor(() => expect(fixture.replyToStop).toBeDefined());
  });
  expect(fixture.requests.filter((r) => r.url.endsWith('/cancel'))).toHaveLength(1);
  await act(async () => {
    renderer.update(tree('chat-2'));
  });
  await act(async () => {
    if (!fixture.replyToStop) throw new Error('Missing Stop request');
    fixture.replyToStop(new Response(null, { status: 503 }));
    await turnDisposed;
  });
  expect(thread.error).toBeNull();
  await act(async () => renderer.unmount());
  queryClient.clear();
});

it('sends the configured Clarity turn and exposes the streamed answer', async () => {
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let thread!: ReturnType<typeof useChatConversation>;
  function Probe() {
    thread = useChatConversation({ conversationId: 'chat-1' });
    return null;
  }
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={queryClient}>
        <ClarityChatRuntime conversationId="chat-1">
          <Probe />
        </ClarityChatRuntime>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(queryClient.getQueryState(['conversation', 'chat-1'])?.status).toBe('success'),
    );
  });
  for (let i = 0; i < 30 && thread.conversationLoading; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(thread.conversationLoading).toBe(false);
  await act(async () => thread.sendMessage('Hello'));
  for (
    let i = 0;
    i < 30 &&
    !thread.messages.some((m) => m.role === 'assistant' && m.content === 'Hello from Alia');
    i++
  ) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect({
    messages: thread.messages,
    error: thread.error,
    requests: fixture.requests,
  }).toMatchObject({
    messages: expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: 'Hello from Alia' }),
    ]),
  });
  const turn = fixture.requests.find((r) => r.url === '/v1/chat/completions');
  expect(turn).toBeDefined();
  if (!turn?.body) throw new Error('Missing turn body');
  expect(JSON.parse(turn.body)).toMatchObject({
    agentId: '01a0646a-078f-7642-95ef-439952f4f3f9',
    conversationId: 'chat-1',
    model: 'auto',
    webSearch: false,
    deepResearch: true,
    stream: true,
    host: { app: 'clarity', version: 1, tools: [] },
  });
  await act(async () => renderer.unmount());
  queryClient.clear();
});

it('creates a Clarity conversation for a first message and opens it', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let thread!: ReturnType<typeof useChatConversation>;
  function Probe({ conversationId }: { conversationId?: string }) {
    thread = useChatConversation({ conversationId });
    return null;
  }
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={queryClient}>
        <ClarityChatRuntime>
          <Probe />
        </ClarityChatRuntime>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    thread.createNewConversation('First message');
    await vi.waitFor(() => expect(fixture.navigate).toHaveBeenCalledWith('/c/chat-1'));
  });
  const created = fixture.requests.find((request) => request.url === '/v1/conversations/new');
  expect(created?.method).toBe('POST');
  if (!created?.body) throw new Error('Missing create body');
  expect(JSON.parse(created.body)).toEqual({
    agentId: '01a0646a-078f-7642-95ef-439952f4f3f9',
    app: 'clarity',
  });
  await act(async () => {
    renderer.update(
      <QueryClientProvider client={queryClient}>
        <ClarityChatRuntime conversationId="chat-1">
          <Probe conversationId="chat-1" />
        </ClarityChatRuntime>
      </QueryClientProvider>,
    );
  });
  for (
    let i = 0;
    i < 30 && !fixture.requests.some((request) => request.url === '/v1/chat/completions');
    i++
  ) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  const turn = fixture.requests.find((request) => request.url === '/v1/chat/completions');
  expect(turn).toBeDefined();
  if (!turn?.body) throw new Error('Missing first turn body');
  expect(JSON.parse(turn.body)).toMatchObject({
    conversationId: 'chat-1',
    messages: [{ role: 'user', content: 'First message' }],
  });
  await act(async () => renderer.unmount());
  queryClient.clear();
});
