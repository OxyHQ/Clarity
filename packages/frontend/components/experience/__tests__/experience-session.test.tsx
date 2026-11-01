import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import SettingsExperienceScreen from '../../../app/(app)/settings/experience';

const state = vi.hoisted(() => ({
  userId: 'alice',
  sessionId: 'alice-session',
  epoch: 0,
}));

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', ScrollView: 'ScrollView' }));
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }));
vi.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    user: { id: state.userId, kind: 'personal' },
    canUsePrivateApi: true,
    isAuthenticated: true,
    oxyServices: { http: { getSessionEpoch: () => state.epoch } },
  }),
  useOxy: () => ({ activeSessionId: state.sessionId }),
  useSupervision: () => ({ data: { self: null } }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { items: [] }, refetch: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@oxy.so/bloom/button', () => ({ Button: 'Button' }));
vi.mock('@oxy.so/bloom/avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('@oxy.so/bloom/loading', () => ({ Loading: 'Loading' }));
vi.mock('@/components/settings/settings-header', () => ({ SettingsHeader: 'Header' }));
vi.mock('@/components/experience/ExperienceEditor', () => ({ ExperienceEditor: 'Editor' }));
vi.mock('@/lib/api/use-experience-client', () => ({ useExperienceClient: () => ({}) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

beforeEach(() => {
  state.userId = 'alice';
  state.sessionId = 'alice-session';
  state.epoch = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

it('discards the open editor on account changes and does not restore it on A to B to A', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<SettingsExperienceScreen />);
  });
  await act(async () => {
    renderer.root.findAllByType('Button' as never)[0].props.onPress();
  });
  expect(renderer.root.findByType('Editor' as never).props.ownerId).toBe('alice');
  await act(async () => renderer.update(<SettingsExperienceScreen />));
  expect(renderer.root.findAllByType('Editor' as never)).toHaveLength(1);
  state.userId = 'bob';
  state.sessionId = 'bob-session';
  state.epoch = 1;
  await act(async () => renderer.update(<SettingsExperienceScreen />));
  expect(renderer.root.findAllByType('Editor' as never)).toHaveLength(0);
  state.userId = 'alice';
  state.sessionId = 'alice-session';
  state.epoch = 2;
  await act(async () => renderer.update(<SettingsExperienceScreen />));
  expect(renderer.root.findAllByType('Editor' as never)).toHaveLength(0);
  await act(async () => renderer.unmount());
});

it('discards the editor when the same account changes sessions', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<SettingsExperienceScreen />);
  });
  await act(async () => {
    renderer.root.findAllByType('Button' as never)[0].props.onPress();
  });
  expect(renderer.root.findAllByType('Editor' as never)).toHaveLength(1);
  state.sessionId = 'alice-other-session';
  state.epoch = 1;
  await act(async () => renderer.update(<SettingsExperienceScreen />));
  expect(renderer.root.findAllByType('Editor' as never)).toHaveLength(0);
  await act(async () => renderer.unmount());
});
