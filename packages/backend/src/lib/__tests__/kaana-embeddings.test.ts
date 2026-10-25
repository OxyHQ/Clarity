import { Kaana } from '@kaana.ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { restoreFetch, stubFetch } from '../../__tests__/support/global-fetch.js';
import type { FetchFunction } from '../fetch-function.js';

const mock = {
  transport: vi.fn(() => ({
    fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    getAccessToken: async () => {
      throw new Error('HTTP must use shared transport');
    },
    dispose: vi.fn(),
  })),
  info: vi.fn(),
  warn: vi.fn(),
};
vi.mock('../clarity-service-auth.js', () => ({
  clarityOxyServer: () => ({ createServiceClient: mock.transport }),
}));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: mock.info, warn: mock.warn }),
}));
const {
  CLARITY_EMBEDDING_DIMENSION,
  CLARITY_EMBEDDING_MODEL,
  createEmbeddings,
  embeddingsEnabled,
  resetEmbeddingReportsForTests,
} = await import('../kaana-embeddings.js');

const vector = (sign: number) =>
  Array.from({ length: CLARITY_EMBEDDING_DIMENSION }, (_, index) => (sign * (index + 1)) / 2048);

/** What `POST https://kaana.ai/v1/embeddings` answers (`@kaana.ai/contracts` 4.4.0). */
function kaanaAnswer(
  body: Record<string, unknown> = {
    object: 'list',
    data: [
      { object: 'embedding', index: 1, embedding: vector(-1) },
      { object: 'embedding', index: 0, embedding: vector(1) },
    ],
    model: `${CLARITY_EMBEDDING_MODEL}@2025-06`,
    usage: { prompt_tokens: 4, total_tokens: 4 },
  },
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'Kaana-Request-Id': 'req_test' },
  });
}

function client(fetch: FetchFunction) {
  return new Kaana({ credential: 'test-token', fetch, maxRetries: 0 });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetEmbeddingReportsForTests();
});

afterEach(() => restoreFetch());

describe('embeddingsEnabled', () => {
  it('is off unless CLARITY_EMBEDDINGS_ENABLED is exactly true, and says so once', () => {
    expect(embeddingsEnabled({})).toBe(false);
    expect(embeddingsEnabled({ CLARITY_EMBEDDINGS_ENABLED: '1' })).toBe(false);
    expect(embeddingsEnabled({ CLARITY_EMBEDDINGS_ENABLED: 'false' })).toBe(false);
    expect(mock.info).toHaveBeenCalledOnce();
    expect(embeddingsEnabled({ CLARITY_EMBEDDINGS_ENABLED: 'true' })).toBe(true);
  });
});

describe('createEmbeddings', () => {
  it('calls kaana.ai/v1/embeddings through the shared workload transport', async () => {
    let url: string | URL | Request | undefined;
    let init: RequestInit | undefined;
    stubFetch(async (requested, requestInit) => {
      url = requested;
      init = requestInit;
      return kaanaAnswer();
    });

    await expect(createEmbeddings(['one', 'two'])).resolves.toEqual([vector(1), vector(-1)]);

    expect(mock.transport).toHaveBeenCalledWith({
      baseURL: 'https://kaana.ai/v1',
      audience: 'kaana.ai',
    });
    expect(url).toBe('https://kaana.ai/v1/embeddings');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    // Literals, not the constants: the model line and dimension are the ones
    // Kaana declares in its catalogue (configs/public-catalogue.json) and the
    // `vector(1024)` columns store, so a change here is a deliberate migration.
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'qwen/qwen3-embedding-8b',
      input: ['one', 'two'],
      dimensions: 1024,
      encoding_format: 'float',
    });
  });

  it('leaves retry scheduling to the durable embedding queue', async () => {
    const request = vi.fn(async () =>
      kaanaAnswer(
        {
          schemaVersion: 1,
          code: 'service_unavailable',
          message: 'try later',
          retryable: true,
          requestId: 'req_test',
        },
        503,
      ),
    );
    stubFetch(request);
    await expect(createEmbeddings(['one'], { queued: true })).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });

  it('refuses vectors of another model line or dimension', async () => {
    const wrongModel = client(async () =>
      kaanaAnswer({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: vector(1) }],
        model: 'other/embedding-model',
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    );
    await expect(createEmbeddings(['one'], { client: wrongModel })).rejects.toThrow(
      'other/embedding-model',
    );

    const shortVectors = client(async () =>
      kaanaAnswer({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0, 1] }],
        model: CLARITY_EMBEDDING_MODEL,
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    );
    await expect(createEmbeddings(['one'], { client: shortVectors })).rejects.toThrow(
      '1024-dimensional',
    );
  });

  it('reports failures at most once per interval, with the count since the last report', async () => {
    const failing = client(async () =>
      kaanaAnswer(
        {
          schemaVersion: 1,
          code: 'service_unavailable',
          message: 'No route could serve this request.',
          retryable: true,
          requestId: 'req_test',
        },
        503,
      ),
    );
    for (let attempt = 0; attempt < 3; attempt += 1)
      await expect(createEmbeddings(['one'], { client: failing })).rejects.toThrow();

    expect(mock.warn).toHaveBeenCalledOnce();
    expect(mock.warn.mock.calls[0][0]).toMatchObject({
      failures: 1,
      code: 'service_unavailable',
      status: 503,
    });
  });

  it('does not authenticate or call Kaana for an empty batch', async () => {
    const request = vi.fn<FetchFunction>();
    await expect(createEmbeddings([], { client: client(request) })).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a batch larger than the contract before calling Kaana', async () => {
    const request = vi.fn<FetchFunction>();
    await expect(
      createEmbeddings(
        Array.from({ length: 2049 }, () => 'text'),
        { client: client(request) },
      ),
    ).rejects.toThrow('at most 2048');
    expect(request).not.toHaveBeenCalled();
  });
});
