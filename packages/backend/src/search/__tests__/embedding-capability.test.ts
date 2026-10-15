import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Embeddings are a capability: without it, indexing and search never call the
 * route (and so never fail on it); with it, a failed call degrades the same way.
 */
const mock = {
  enabled: vi.fn(() => false),
  create: vi.fn(async (texts: readonly string[]) => texts.map(() => [0.1])),
};
vi.mock('../../lib/kaana-embeddings.js', () => ({
  CLARITY_EMBEDDING_MODEL: 'test-embedding-model',
  embeddingsEnabled: mock.enabled,
  createEmbeddings: mock.create,
}));
const { embedChunks, embedQuery } = await import('../chunking.js');

beforeEach(() => {
  vi.clearAllMocks();
  mock.enabled.mockReturnValue(false);
  mock.create.mockImplementation(async (texts: readonly string[]) => texts.map(() => [0.1]));
});

describe('without the embeddings capability', () => {
  it('stores chunks unembedded and ranks queries lexically without calling the route', async () => {
    await expect(embedChunks(['one', 'two'])).resolves.toBeUndefined();
    await expect(embedQuery('query')).resolves.toBeUndefined();
    expect(mock.create).not.toHaveBeenCalled();
  });
});

describe('with the embeddings capability', () => {
  beforeEach(() => mock.enabled.mockReturnValue(true));

  it('embeds chunks in batches the route accepts', async () => {
    const texts = Array.from({ length: 130 }, (_, index) => `chunk ${index}`);
    const embeddings = await embedChunks(texts);
    expect(embeddings).toHaveLength(130);
    expect(mock.create.mock.calls.map(([batch]) => batch.length)).toEqual([128, 2]);
  });

  it('embeds a query', async () => {
    await expect(embedQuery('query')).resolves.toEqual([0.1]);
    expect(mock.create).toHaveBeenCalledWith(['query'], {});
  });

  it('degrades to no embeddings when the route fails', async () => {
    mock.create.mockRejectedValue(new Error('service_unavailable'));
    await expect(embedChunks(['one'])).resolves.toBeUndefined();
    await expect(embedQuery('query')).resolves.toBeUndefined();
  });

  it('calls nothing for a document without chunks', async () => {
    await expect(embedChunks([])).resolves.toBeUndefined();
    expect(mock.create).not.toHaveBeenCalled();
  });
});
