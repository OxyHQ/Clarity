import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/redis.js', () => {
  const store = new Map<string, Buffer>();
  const client = {
    store,
    getBuffer: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: Buffer) => {
      store.set(key, value);
      return 'OK';
    },
  };
  return {
    getRedisClient: () => client,
    withRedisTimeout: <T>(promise: Promise<T>) => promise,
  };
});
vi.mock('../../lib/kaana-embeddings.js', () => ({
  CLARITY_EMBEDDING_MODEL: 'test-embedding-model',
  embeddingsEnabled: vi.fn(() => true),
  createEmbeddings: vi.fn(),
}));

import { createEmbeddings } from '../../lib/kaana-embeddings.js';
import { getRedisClient } from '../../lib/redis.js';
import { embedQuery } from '../chunking.js';

const store = (getRedisClient() as unknown as { store: Map<string, Buffer> }).store;

describe('embedQuery', () => {
  beforeEach(() => {
    store.clear();
    (createEmbeddings as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it('asks Kaana once for a query, then answers it from the cache', async () => {
    const vector = Array.from({ length: 1024 }, (_, index) => (index % 7) / 8);
    (createEmbeddings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([vector]);

    expect(await embedQuery('rust developer')).toEqual(vector);
    // The write is not awaited by the search; let it land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await embedQuery('rust developer')).toEqual(vector);
    expect(createEmbeddings).toHaveBeenCalledOnce();

    // Another query is its own entry.
    await embedQuery('gardener');
    expect(createEmbeddings).toHaveBeenCalledTimes(2);
  });

  it('caches nothing when the embedding fails', async () => {
    (createEmbeddings as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('route unavailable'),
    );
    expect(await embedQuery('nurse')).toBeUndefined();
    expect(store.size).toBe(0);
  });
});
