import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { accountQueryOwnership } from '../account-query-ownership';

/* Exercise the persister shipped by the pinned Services package. It is an
 * implementation detail of OxyProvider and is not a public SDK export. */
const require = createRequire(import.meta.url);
const servicesRoot = dirname(require.resolve('@oxy.so/services'));
const { createAccountQueryPersistence } = require(
  join(servicesRoot, 'ui/hooks/accountQueryPersistence.js'),
) as {
  createAccountQueryPersistence: (
    client: QueryClient,
    config?: typeof accountQueryOwnership,
  ) => {
    activate: (subject: string | null) => void;
    setStorage: (storage: {
      getItem: (key: string) => Promise<string | null>;
      setItem: (key: string, value: string) => Promise<void>;
      removeItem: (key: string) => Promise<void>;
    }) => void;
    attach: () => void;
    detach: () => void;
    whenReady: () => Promise<void>;
  };
};

describe('private account query ownership', () => {
  it('drops private reads on a subject change while preserving public searches', () => {
    const client = new QueryClient();
    const owner = createAccountQueryPersistence(client, accountQueryOwnership);
    owner.activate('alice');
    client.setQueryData(['notifications', 30], { notifications: ['alice'] });
    client.setQueryData(['subscription', 'clarity'], { userId: 'alice' });
    client.setQueryData(['subscription-poll', 'clarity'], { userId: 'alice' });
    client.setQueryData(['jobs', 'search'], ['public job']);

    owner.activate('bob');

    expect(client.getQueryData(['notifications', 30])).toBeUndefined();
    expect(client.getQueryData(['subscription', 'clarity'])).toBeUndefined();
    expect(client.getQueryData(['subscription-poll', 'clarity'])).toBeUndefined();
    expect(client.getQueryData(['jobs', 'search'])).toEqual(['public job']);
    client.clear();
  });

  it('does not revive an old subject response after a switch', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const owner = createAccountQueryPersistence(client, accountQueryOwnership);
    owner.activate('alice');
    let finish!: (value: string) => void;
    const pending = client
      .fetchQuery({
        queryKey: ['notifications', 30],
        queryFn: () => new Promise<string>((resolve) => (finish = resolve)),
      })
      .catch(() => undefined);

    owner.activate('bob');
    client.setQueryData(['notifications', 30], 'bob');
    finish('alice');
    await pending;

    expect(client.getQueryData(['notifications', 30])).toBe('bob');
    client.clear();
  });

  it('does not show the old result when a mounted observer renders the next account', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const owner = createAccountQueryPersistence(client, accountQueryOwnership);
    owner.activate('alice');
    client.setQueryData(['notifications', 30], 'alice');
    let displayed: unknown;
    function Screen({ subject }: { subject: string }) {
      const query = useQuery({
        queryKey: ['notifications', 30],
        queryFn: () => new Promise<string>(() => {}),
      });
      displayed = [subject, query.data];
      return null;
    }
    const screen = (subject: string) =>
      createElement(QueryClientProvider, { client }, createElement(Screen, { subject }));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(screen('alice'));
    });
    expect(displayed).toEqual(['alice', 'alice']);

    await act(async () => {
      owner.activate('bob');
      renderer.update(screen('bob'));
    });
    expect(displayed).toEqual(['bob', undefined]);
    await act(async () => renderer.unmount());
    client.clear();
  });

  it('does not persist the private data when leaving an account', async () => {
    const items = new Map<string, string>();
    const client = new QueryClient();
    const owner = createAccountQueryPersistence(client, accountQueryOwnership);
    owner.setStorage({
      getItem: async (key) => items.get(key) ?? null,
      setItem: async (key, value) => void items.set(key, value),
      removeItem: async (key) => void items.delete(key),
    });
    owner.attach();
    owner.activate('alice');
    await owner.whenReady();
    client.setQueryData(['notifications', 30], 'private notification');
    client.setQueryData(['subscription', 'clarity'], 'private subscription');
    owner.activate('bob');
    await owner.whenReady();

    expect([...items.values()].join()).not.toContain('private notification');
    expect([...items.values()].join()).not.toContain('private subscription');
    owner.detach();
    client.clear();
  });
});
