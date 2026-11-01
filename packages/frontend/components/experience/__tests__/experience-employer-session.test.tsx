import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import { ExperienceEmployerField } from '../ExperienceEmployerField';

const state = vi.hoisted(() => ({
  epoch: 0,
  create: vi.fn(),
  search: vi.fn(),
}));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text' }));
vi.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    user: { id: 'alice' },
    canUsePrivateApi: true,
    isAuthenticated: true,
    oxyServices: {
      http: { getSessionEpoch: () => state.epoch },
      organizations: { create: state.create, search: state.search },
    },
  }),
  useOxy: () => ({ activeSessionId: 'alice-session' }),
  useSupervision: () => ({ data: { self: null } }),
}));
vi.mock('@oxy.so/bloom/button', () => ({ Button: 'Button' }));
vi.mock('@oxy.so/bloom/avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('@oxy.so/bloom/loading', () => ({ Loading: 'Loading' }));
vi.mock('@oxy.so/bloom/item', () => ({ Item: 'Item' }));
vi.mock('@oxy.so/bloom/text-field', () => ({
  TextField: 'TextField',
  TextFieldInput: 'Input',
  TextFieldLabel: 'Label',
}));
vi.mock('@oxy.so/bloom/select', () => ({
  Select: 'Select',
  SelectContent: 'SelectContent',
  SelectItem: 'SelectItem',
  SelectItemText: 'SelectItemText',
  SelectTrigger: 'SelectTrigger',
  SelectValue: 'SelectValue',
}));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

beforeEach(() => {
  state.epoch = 0;
  state.create.mockReset();
  state.search.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

it('does not resume organization creation in another session', async () => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={client}>
          <ExperienceEmployerField value="" disabled={false} invalid={false} onChange={() => {}} />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      renderer.root.findByType('Input' as never).props.onChangeText('Example');
      await new Promise((resolve) => setTimeout(resolve, 330));
    });
    const button = (label: string) =>
      renderer.root.findAllByType('Button' as never).find((node) => node.props.children === label);
    for (
      let attempt = 0;
      attempt < 100 && !button('profile.experience.addOrganization');
      attempt++
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(button('profile.experience.addOrganization')).toBeDefined();
    await act(async () => button('profile.experience.addOrganization')?.props.onPress());
    onlineManager.setOnline(false);
    await act(async () => button('profile.experience.createOrganization')?.props.onPress());
    expect(
      client
        .getMutationCache()
        .getAll()
        .some((mutation) => mutation.state.isPaused),
    ).toBe(true);
    state.epoch = 1;
    await act(async () => {
      onlineManager.setOnline(true);
      await client.resumePausedMutations();
    });
    expect(state.create).not.toHaveBeenCalled();
  } finally {
    onlineManager.setOnline(true);
    if (renderer) await act(async () => renderer.unmount());
    client.clear();
  }
});
