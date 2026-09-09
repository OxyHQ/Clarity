import { describe, expect, it, vi } from 'vitest';

import {
  CLARITY_EMBEDDING_DIMENSION,
  CLARITY_EMBEDDING_MODEL,
  createOxyEmbeddings,
} from '../oxy-embeddings.js';

describe('createOxyEmbeddings', () => {
  it('calls the exact Oxy embedding route and restores vector order', async () => {
    const first = Array.from({ length: CLARITY_EMBEDDING_DIMENSION }, (_, index) => index / 1024);
    const second = Array.from({ length: CLARITY_EMBEDDING_DIMENSION }, (_, index) => -(index + 1) / 1024);
    let requestedUrl: string | URL | Request | undefined;
    let requestedInit: RequestInit | undefined;
    const request = vi.fn<typeof fetch>(async (url, init) => {
      requestedUrl = url;
      requestedInit = init;
      return new Response(JSON.stringify({
        schemaVersion: 1,
        requestId: 'request-1',
        model: CLARITY_EMBEDDING_MODEL,
        dimension: CLARITY_EMBEDDING_DIMENSION,
        data: [{ index: 1, embedding: second }, { index: 0, embedding: first }],
        usage: { inputTokens: 4, totalTokens: 4 },
      }), { status: 200 });
    });

    await expect(createOxyEmbeddings(['one', 'two'], {
      baseUrl: 'https://oxy.test/',
      fetch: request,
      getToken: async () => 'service-token',
    })).resolves.toEqual([first, second]);

    expect(request).toHaveBeenCalledOnce();
    expect(requestedUrl).toBe('https://oxy.test/v1/embeddings');
    expect(requestedInit?.headers).toEqual({ authorization: 'Bearer service-token', 'content-type': 'application/json' });
    expect(JSON.parse(String(requestedInit?.body))).toEqual({
      model: CLARITY_EMBEDDING_MODEL,
      input: ['one', 'two'],
      dimensions: CLARITY_EMBEDDING_DIMENSION,
      labels: { product: 'clarity', operation: 'search_indexing' },
    });
  });

  it('rejects upstream failures and malformed dimensions', async () => {
    await expect(createOxyEmbeddings(['one'], {
      fetch: async () => new Response(null, { status: 503 }),
      getToken: async () => 'service-token',
    })).rejects.toMatchObject({ name: 'OxyEmbeddingError', status: 503 });

    await expect(createOxyEmbeddings(['one'], {
      fetch: async () => new Response(JSON.stringify({
        schemaVersion: 1, requestId: 'request-2', model: CLARITY_EMBEDDING_MODEL,
        dimension: 2, data: [{ index: 0, embedding: [0, 1] }], usage: { inputTokens: 1, totalTokens: 1 },
      }), { status: 200 }),
      getToken: async () => 'service-token',
    })).rejects.toThrow('invalid embeddings response');
  });

  it('does not authenticate or call Oxy for an empty batch', async () => {
    const getToken = vi.fn(async () => 'service-token');
    const request = vi.fn<typeof fetch>();
    await expect(createOxyEmbeddings([], { getToken, fetch: request })).resolves.toEqual([]);
    expect(getToken).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a batch larger than the Oxy contract before authenticating', async () => {
    const getToken = vi.fn(async () => 'service-token');
    await expect(createOxyEmbeddings(Array.from({ length: 2049 }, () => 'text'), { getToken }))
      .rejects.toThrow('at most 2048');
    expect(getToken).not.toHaveBeenCalled();
  });
});
