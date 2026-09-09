import { z } from 'zod';

import { getClarityServiceToken } from './clarity-service-auth.js';

export const CLARITY_EMBEDDING_MODEL = 'qwen/qwen3-embedding-0.6b';
export const CLARITY_EMBEDDING_DIMENSION = 1024;

const embeddingResponseSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().min(1),
  model: z.string().min(1),
  dimension: z.literal(CLARITY_EMBEDDING_DIMENSION),
  data: z.array(z.object({
    index: z.number().int().nonnegative(),
    embedding: z.array(z.number().finite()).length(CLARITY_EMBEDDING_DIMENSION),
  }).strict()).min(1),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  }).strict(),
}).strict();

interface EmbeddingClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  getToken?: () => Promise<string>;
  signal?: AbortSignal;
}

export class OxyEmbeddingError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'OxyEmbeddingError';
  }
}

export async function createOxyEmbeddings(
  input: string[],
  options: EmbeddingClientOptions = {},
): Promise<number[][]> {
  if (input.length === 0) return [];
  if (input.length > 2048) throw new OxyEmbeddingError('Oxy accepts at most 2048 embedding inputs per request');
  const token = await (options.getToken ?? getClarityServiceToken)();
  const response = await (options.fetch ?? fetch)(
    `${(options.baseUrl ?? process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, '')}/v1/embeddings`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: CLARITY_EMBEDDING_MODEL,
        input,
        dimensions: CLARITY_EMBEDDING_DIMENSION,
        labels: { product: 'clarity', operation: 'search_indexing' },
      }),
      signal: options.signal ?? AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new OxyEmbeddingError(`Oxy embeddings request failed with status ${response.status}`, response.status);
  }
  const parsed = embeddingResponseSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.data.length !== input.length) {
    throw new OxyEmbeddingError('Oxy returned an invalid embeddings response');
  }
  const ordered = [...parsed.data.data].sort((left, right) => left.index - right.index);
  if (ordered.some((item, index) => item.index !== index)) {
    throw new OxyEmbeddingError('Oxy returned non-contiguous embedding indexes');
  }
  return ordered.map((item) => item.embedding);
}
