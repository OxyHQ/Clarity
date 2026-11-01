import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import { ExperienceEditor } from '../ExperienceEditor';

const state = vi.hoisted(() => ({
  epoch: 0,
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', ScrollView: 'ScrollView' }));
vi.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    user: { id: 'alice' },
    canUsePrivateApi: true,
    oxyServices: { http: { getSessionEpoch: () => state.epoch } },
  }),
}));
vi.mock('@/lib/api/use-experience-client', () => ({
  useExperienceClient: () => ({ update: state.update, delete: state.remove }),
}));
vi.mock('@oxy.so/bloom/button', () => ({ Button: 'Button' }));
vi.mock('@oxy.so/bloom/dialog', async () => {
  const React = await import('react');
  return {
    Dialog: 'Dialog',
    useDialogControl: () =>
      React.useMemo(() => ({ open: () => {}, close: (fn?: () => void) => fn?.() }), []),
  };
});
vi.mock('@oxy.so/bloom/switch', () => ({ Switch: 'Switch' }));
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
vi.mock('../ExperienceEmployerField', () => ({ ExperienceEmployerField: 'Employer' }));

const entry = {
  id: 'role',
  oxyUserId: 'alice',
  title: 'Designer',
  employerOxyAccountId: 'employer',
  startDate: '2022-10',
  endDate: null,
  employmentType: 'full-time',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
} as const;

beforeEach(() => {
  state.epoch = 0;
  state.update.mockReset();
  state.remove.mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

it('rejects a paused save and a retained delete after the session changes', async () => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  let renderer!: ReactTestRenderer;
  onlineManager.setOnline(false);
  try {
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={client}>
          <ExperienceEditor entry={entry} ownerId="alice" onClose={() => {}} onSaved={() => {}} />
        </QueryClientProvider>,
      );
    });
    const buttons = renderer.root.findAllByType('Button' as never);
    await act(async () =>
      buttons.find((button) => button.props.children === 'common.save')?.props.onPress(),
    );
    expect(
      client
        .getMutationCache()
        .getAll()
        .some((mutation) => mutation.state.isPaused),
    ).toBe(true);
    await act(async () =>
      buttons.find((button) => button.props.children === 'common.delete')?.props.onPress(),
    );
    const deleteAction = renderer.root.findByType('Dialog' as never).props.actions[1].onPress;
    state.epoch = 1;
    await act(async () => {
      deleteAction();
      onlineManager.setOnline(true);
      await client.resumePausedMutations();
    });
    expect(state.update).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  } finally {
    onlineManager.setOnline(true);
    if (renderer) await act(async () => renderer.unmount());
    client.clear();
  }
});

it.each([
  { epoch: 0, expectedCalls: 1 },
  { epoch: 1, expectedCalls: 0 },
])(
  'runs the saved callback only in its initiating session (epoch $epoch)',
  async ({ epoch, expectedCalls }) => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    let finish!: (value: typeof entry) => void;
    state.update.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const onSaved = vi.fn();
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(
          <QueryClientProvider client={client}>
            <ExperienceEditor entry={entry} ownerId="alice" onClose={() => {}} onSaved={onSaved} />
          </QueryClientProvider>,
        );
      });
      const save = renderer.root
        .findAllByType('Button' as never)
        .find((button) => button.props.children === 'common.save');
      await act(async () => save?.props.onPress());
      expect(state.update).toHaveBeenCalledTimes(1);
      state.epoch = epoch;
      await act(async () => {
        finish(entry);
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(onSaved).toHaveBeenCalledTimes(expectedCalls);
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      client.clear();
    }
  },
);
