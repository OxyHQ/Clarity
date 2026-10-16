import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Embeddings are a capability: without it, indexing and search never call the
 * route (and so never fail on it); with it, a failed call degrades the same way.
 */
const mock = {
  enabled: vi.fn(() => false),
  create: vi.fn(async (texts: readonly string[]) => texts.map(() => [0.1])),
  getDb: vi.fn(() => {
    throw new Error('the database was read');
  }),
};
vi.mock('../../lib/kaana-embeddings.js', () => ({
  CLARITY_EMBEDDING_MODEL: 'test-embedding-model',
  embeddingsEnabled: mock.enabled,
  createEmbeddings: mock.create,
}));
vi.mock('../../db/index.js', () => ({ getDb: mock.getDb }));
const { embedQuery, queueChunkEmbeddings } = await import('../chunking.js');

beforeEach(() => {
  vi.clearAllMocks();
  mock.enabled.mockReturnValue(false);
  mock.create.mockImplementation(async (texts: readonly string[]) => texts.map(() => [0.1]));
});

describe('without the embeddings capability', () => {
  it('queues no chunk and ranks queries lexically without calling the route', async () => {
    await queueChunkEmbeddings('document-1');
    await expect(embedQuery('query')).resolves.toBeUndefined();
    expect(mock.getDb).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
  });
});

describe('with the embeddings capability', () => {
  beforeEach(() => mock.enabled.mockReturnValue(true));

  it('embeds a query on its own, without the indexing queue', async () => {
    await expect(embedQuery('query')).resolves.toEqual([0.1]);
    expect(mock.create).toHaveBeenCalledWith(['query'], {});
  });

  it('degrades a query to no embedding when the route fails', async () => {
    mock.create.mockRejectedValue(new Error('service_unavailable'));
    await expect(embedQuery('query')).resolves.toBeUndefined();
  });

  it('leaves a document indexed when its chunks cannot be read for the queue', async () => {
    await expect(queueChunkEmbeddings('document-1')).resolves.toBeUndefined();
    expect(mock.getDb).toHaveBeenCalledOnce();
    expect(mock.create).not.toHaveBeenCalled();
  });
});
