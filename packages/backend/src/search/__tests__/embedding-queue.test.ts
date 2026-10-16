import {
  KaanaInvalidRequestError,
  KaanaRateLimitError,
  KaanaUnavailableError,
} from '@kaana.ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EmbeddingQueue,
  estimatedTokens,
  FAILURE_BACKOFF_MS,
  MAX_BATCH_ESTIMATED_TOKENS,
  MAX_BATCH_INPUTS,
  MAX_PENDING_CHUNKS,
  MAX_WAIT_MS,
  MIN_REQUEST_INTERVAL_MS,
  type PendingChunk,
} from '../embedding-queue.js';

/** A document's chunks, the way indexing queues them: ~4 of up to 2,000 characters. */
function documentChunks(document: number, count = 4, length = 2_000): PendingChunk[] {
  return Array.from({ length: count }, (_, position) => ({
    id: `doc-${document}-chunk-${position}`,
    text: `${document}:${position} `.padEnd(length, 'x'),
  }));
}

function harness() {
  const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => [0.5]));
  const stored: string[] = [];
  const store = vi.fn(async (chunks: readonly PendingChunk[]) => {
    stored.push(...chunks.map(({ id }) => id));
  });
  return { queue: new EmbeddingQueue({ embed, store }), embed, store, stored };
}

/**
 * Advances the fake clock, then lets the request a timer started settle. Bun's
 * test runner has no `advanceTimersByTimeAsync`; the unit suite runs on both.
 */
async function advance(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

const requestSizes = (embed: ReturnType<typeof harness>['embed']) =>
  embed.mock.calls.map(([texts]) => texts.length);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('EmbeddingQueue', () => {
  it('embeds the chunks of many documents in one request', async () => {
    const { queue, embed, stored } = harness();
    // Ten documents indexed one after another, as the feed loop and the
    // crawler index them: one request per document used to be ten.
    for (let document = 0; document < 10; document += 1) queue.enqueue(documentChunks(document));

    await advance(MAX_WAIT_MS - 1);
    expect(embed).not.toHaveBeenCalled();
    await advance(1);

    expect(requestSizes(embed)).toEqual([40]);
    expect(stored).toHaveLength(40);
    expect(queue.pending).toBe(0);
  });

  it('sends a full batch at once, then one request per interval, each within both bounds', async () => {
    const { queue, embed } = harness();
    // 75 documents of 4 chunks: two full requests and a partial one.
    for (let document = 0; document < 75; document += 1) queue.enqueue(documentChunks(document));

    await advance(0);
    expect(requestSizes(embed)).toEqual([MAX_BATCH_INPUTS]);
    await advance(MIN_REQUEST_INTERVAL_MS - 1);
    expect(requestSizes(embed)).toEqual([MAX_BATCH_INPUTS]);
    await advance(1);
    expect(requestSizes(embed)).toEqual([MAX_BATCH_INPUTS, MAX_BATCH_INPUTS]);
    // The 44 left are not a full batch: they wait for MAX_WAIT_MS from when they were queued.
    await advance(MAX_WAIT_MS);
    expect(requestSizes(embed)).toEqual([MAX_BATCH_INPUTS, MAX_BATCH_INPUTS, 44]);

    for (const [texts] of embed.mock.calls) {
      expect(texts.length).toBeLessThanOrEqual(MAX_BATCH_INPUTS);
      const tokens = texts.reduce((sum, text) => sum + estimatedTokens(text), 0);
      expect(tokens).toBeLessThanOrEqual(MAX_BATCH_ESTIMATED_TOKENS);
    }
  });

  it('stops a batch at the estimated-token bound before the input bound', async () => {
    const { queue, embed } = harness();
    // 8,000 characters is 2,001 estimated tokens: 32 fit in 65,536, 33 do not.
    for (let document = 0; document < 20; document += 1)
      queue.enqueue(documentChunks(document, 2, 8_000));

    await advance(0);
    expect(requestSizes(embed)).toEqual([32]);
    await advance(MIN_REQUEST_INTERVAL_MS + MAX_WAIT_MS);
    expect(requestSizes(embed)).toEqual([32, 8]);
  });

  it('matches what Kaana estimates for a full batch of 2,000-character chunks', () => {
    expect(estimatedTokens('x'.repeat(2_000))).toBe(501);
    expect(MAX_BATCH_INPUTS * 501).toBeLessThanOrEqual(MAX_BATCH_ESTIMATED_TOKENS);
  });

  it('backs the queue off for the Retry-After Kaana stated, then embeds the same chunks', async () => {
    const { queue, embed, stored } = harness();
    embed.mockRejectedValueOnce(
      new KaanaRateLimitError({
        code: 'rate_limited',
        message: 'the request rate limit was reached; retry later',
        status: 429,
        requestId: 'req_limited',
        retryable: true,
        retryAfterMs: 42_000,
      }),
    );
    queue.enqueue(documentChunks(1));
    queue.enqueue(documentChunks(2));

    await advance(MAX_WAIT_MS);
    expect(requestSizes(embed)).toEqual([8]);
    expect(stored).toEqual([]);

    // Indexing goes on meanwhile; nothing is sent until the wait has passed.
    queue.enqueue(documentChunks(3));
    await advance(42_000 - 1);
    expect(embed).toHaveBeenCalledTimes(1);
    await advance(1);

    expect(requestSizes(embed)).toEqual([8, 12]);
    // The refused chunks first, then what was queued during the back-off.
    expect(embed.mock.calls[1][0]).toEqual(
      [...documentChunks(1), ...documentChunks(2), ...documentChunks(3)].map(({ text }) => text),
    );
    expect(stored).toHaveLength(12);
  });

  it('backs off longer after each consecutive failure, and resets after a success', async () => {
    const { queue, embed, stored } = harness();
    const unavailable = () =>
      new KaanaUnavailableError({
        code: 'service_unavailable',
        message: 'The service is temporarily unavailable.',
        status: 503,
        requestId: 'req_unavailable',
        retryable: true,
        retryAfterMs: 1_000,
      });
    embed.mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable());
    queue.enqueue(documentChunks(1));

    await advance(MAX_WAIT_MS);
    expect(embed).toHaveBeenCalledTimes(1);
    // Kaana asked for a second; the floor holds the queue for five.
    await advance(FAILURE_BACKOFF_MS);
    expect(embed).toHaveBeenCalledTimes(2);
    await advance(2 * FAILURE_BACKOFF_MS - 1);
    expect(embed).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(embed).toHaveBeenCalledTimes(3);
    expect(stored).toHaveLength(4);
  });

  it('drops a batch Kaana refuses outright, and keeps serving the rest', async () => {
    const { queue, embed, stored } = harness();
    embed.mockRejectedValueOnce(
      new KaanaInvalidRequestError({
        code: 'invalid_request',
        message: 'The request is invalid.',
        status: 400,
        requestId: 'req_invalid',
        retryable: false,
      }),
    );
    queue.enqueue(documentChunks(1));
    await advance(MAX_WAIT_MS);
    expect(queue.pending).toBe(0);

    queue.enqueue(documentChunks(2));
    await advance(MAX_WAIT_MS);
    expect(requestSizes(embed)).toEqual([4, 4]);
    expect(stored).toEqual(documentChunks(2).map(({ id }) => id));
  });

  it('queues a chunk once, and holds at most MAX_PENDING_CHUNKS', () => {
    const { queue } = harness();
    queue.enqueue(documentChunks(1));
    queue.enqueue(documentChunks(1));
    expect(queue.pending).toBe(4);

    for (let document = 2; document < 2 + MAX_PENDING_CHUNKS / 4 + 10; document += 1)
      queue.enqueue(documentChunks(document));
    expect(queue.pending).toBe(MAX_PENDING_CHUNKS);
  });

  it('keeps the chunks unembedded when storing fails, and goes on', async () => {
    const onStoreFailure = vi.fn();
    const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => [0.5]));
    const store = vi.fn().mockRejectedValueOnce(new Error('connection lost'));
    const queue = new EmbeddingQueue({ embed, store, onStoreFailure });
    queue.enqueue(documentChunks(1));
    await advance(MAX_WAIT_MS);
    expect(onStoreFailure).toHaveBeenCalledWith(expect.any(Error), 4);

    queue.enqueue(documentChunks(2));
    await advance(MAX_WAIT_MS);
    expect(store).toHaveBeenCalledTimes(2);
  });
});
