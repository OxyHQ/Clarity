/**
 * Chunk embeddings, written behind indexing in requests that span documents.
 *
 * Indexing stores a document's chunks unembedded (lexically searchable at
 * once) and hands them here; the queue sends them to Kaana in requests of up to
 * {@link MAX_BATCH_INPUTS} inputs and {@link MAX_BATCH_ESTIMATED_TOKENS}
 * estimated tokens, whatever documents they came from, and writes the vectors
 * back.
 *
 * Embedding one document per request (~4 chunks) cost one Oxy grant per
 * document: ~70 a minute against the machine lane's 60 per credential, and the
 * excess was refused (2026-10-16). A request now carries every chunk that is
 * pending when it is sent:
 *
 * - a full batch is sent at once, but never sooner than
 *   {@link MIN_REQUEST_INTERVAL_MS} after the previous request (at most 30 a
 *   minute, half the credential's limit, which search queries share), and
 *   never more than {@link MAX_IN_FLIGHT} at a time;
 * - a partial batch is sent once its oldest chunk has waited
 *   {@link MAX_WAIT_MS}, so a quiet index still embeds within seconds.
 *
 * A failed request backs off the QUEUE, never one document: no request is sent
 * before the `Retry-After` Kaana stated, nor before a floor that doubles with
 * each consecutive failure. A retryable failure (rate limited, unavailable, a
 * timeout) keeps its chunks at the head of the queue; any other drops them, and
 * they stay unembedded until their document is indexed again. Nothing is lost
 * with the process either: an unembedded chunk is queued again whenever its
 * document is re-indexed (`documentChunkState` reports it `unembedded`).
 */
import { KaanaConnectionError, KaanaError } from '@kaana.ai/sdk';

import { integerKnob } from '../lib/work-knobs.js';

/** Inputs per request: what Kaana's pilot embeds per request for Clarity. */
export const MAX_BATCH_INPUTS = 128;
/** Estimated tokens per request: the pilot's `maxInputTokens`. */
export const MAX_BATCH_ESTIMATED_TOKENS = 65_536;
/** The longest a pending chunk waits for a batch to fill. */
export const MAX_WAIT_MS = 10_000;
/**
 * The shortest gap between two requests (`EMBED_MIN_REQUEST_INTERVAL_MS`,
 * default 2 s). Never below 1 s: 60 a minute is the credential's whole limit,
 * which search queries share.
 */
export const MIN_REQUEST_INTERVAL_MS = integerKnob(
  process.env,
  'EMBED_MIN_REQUEST_INTERVAL_MS',
  2_000,
  { min: 1_000, max: 10 * 60_000 },
);
/**
 * Requests in flight at once. Kaana answers a full batch in 5–12 s, so one at a
 * time embedded ~38k chunks an hour against ~9k new ones, and the 2.4M-chunk
 * backlog would have taken 3.4 days (production, 2026-10-21). Two at a time,
 * still at most 30 requests a minute, roughly double it; vector writes are two
 * narrow rows each (search/chunking.ts), ~0.02 average active sessions at the
 * old pace. `EMBED_MAX_IN_FLIGHT` (1–8) overrides it.
 */
export const MAX_IN_FLIGHT = integerKnob(process.env, 'EMBED_MAX_IN_FLIGHT', 2, { min: 1, max: 8 });
/** Chunks held at most; more are left unembedded until their document is indexed again. */
export const MAX_PENDING_CHUNKS = 4_096;
/**
 * A store slower than this means the shared database is struggling: a healthy
 * one writes a batch's two narrow rows a chunk in well under a second. The queue
 * then rests as long as that store took, so it never spends more than half its
 * time writing into an index that is already starved for disk reads. Production
 * on 2026-11-26: 341 stores in 90 minutes averaged 22 s each while the disk sat
 * at its throughput ceiling, and they slowed every other app's queries on the
 * instance (crawl leases 19 s, identity locks 8 s). `SLOW_STORE_MS` overrides it.
 */
export const SLOW_STORE_MS = integerKnob(process.env, 'SLOW_STORE_MS', 2_000, {
  min: 0,
  max: 10 * 60_000,
});
/** The longest the queue rests after one slow store (`MAX_STORE_REST_MS`; 0 never rests). */
export const MAX_STORE_REST_MS = integerKnob(process.env, 'MAX_STORE_REST_MS', 60_000, {
  min: 0,
  max: 60 * 60_000,
});
/** The back-off after a first failure, doubled by each consecutive one up to the maximum. */
export const FAILURE_BACKOFF_MS = 5_000;
export const MAX_FAILURE_BACKOFF_MS = 5 * 60_000;

/**
 * Kaana's estimate of an input's tokens (UTF-16 length / 4 + 1), rounded up so
 * a batch is never larger than Kaana counts it.
 */
export function estimatedTokens(text: string): number {
  return Math.ceil(text.length / 4) + 1;
}

export interface PendingChunk {
  id: string;
  text: string;
}

/** The pacing knobs one queue runs with; the module's constants by default. */
export interface EmbeddingQueueLimits {
  maxInFlight: number;
  minRequestIntervalMs: number;
  slowStoreMs: number;
  maxStoreRestMs: number;
}

export interface EmbeddingQueueOptions {
  /** One vector per text, in order. */
  embed: (texts: readonly string[]) => Promise<number[][]>;
  /** Writes the vectors of chunks that were embedded. */
  store: (chunks: readonly PendingChunk[], embeddings: number[][]) => Promise<void>;
  /** Called when storing fails; the chunks stay unembedded. */
  onStoreFailure?: (error: unknown, chunks: number) => void;
  /** Overrides of the pacing knobs (tests); unset ones use the constants. */
  limits?: Partial<EmbeddingQueueLimits>;
}

/** Whether a failure is worth sending the same chunks again once the queue has backed off. */
function retryable(error: unknown): boolean {
  return (error instanceof KaanaError && error.retryable) || error instanceof KaanaConnectionError;
}

function statedWait(error: unknown): number {
  return error instanceof KaanaError ? (error.retryAfterMs ?? 0) : 0;
}

interface Entry {
  chunk: PendingChunk;
  queuedAt: number;
}

export class EmbeddingQueue {
  readonly #options: EmbeddingQueueOptions;
  readonly #limits: EmbeddingQueueLimits;
  /** Pending chunks by id, oldest first. */
  #pending = new Map<string, Entry>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight = 0;
  #lastRequestAt = Number.NEGATIVE_INFINITY;
  #backoffUntil = Number.NEGATIVE_INFINITY;
  #storeRestUntil = Number.NEGATIVE_INFINITY;
  #consecutiveFailures = 0;

  constructor(options: EmbeddingQueueOptions) {
    this.#options = options;
    this.#limits = {
      maxInFlight: MAX_IN_FLIGHT,
      minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
      slowStoreMs: SLOW_STORE_MS,
      maxStoreRestMs: MAX_STORE_REST_MS,
      ...options.limits,
    };
  }

  /** How many chunks are waiting. */
  get pending(): number {
    return this.#pending.size;
  }

  /** Queues chunks to embed. A chunk already pending keeps its place. */
  enqueue(chunks: readonly PendingChunk[]): void {
    const queuedAt = Date.now();
    for (const chunk of chunks) {
      if (this.#pending.size >= MAX_PENDING_CHUNKS) break;
      if (!this.#pending.has(chunk.id)) this.#pending.set(chunk.id, { chunk, queuedAt });
    }
    this.#schedule();
  }

  /**
   * Test seam: sends the pending batches now, without the waits, until the
   * queue is empty or backs off.
   */
  async flush(): Promise<void> {
    while (this.#pending.size > 0 && this.#inFlight === 0) {
      const before = this.#pending.size;
      await this.#send();
      if (this.#pending.size >= before) return;
    }
  }

  /** The next request's chunks, from the head of the queue, within both bounds. */
  #nextBatch(): [string, Entry][] {
    const batch: [string, Entry][] = [];
    let tokens = 0;
    for (const [id, entry] of this.#pending) {
      const estimate = estimatedTokens(entry.chunk.text);
      if (
        batch.length === MAX_BATCH_INPUTS ||
        (batch.length > 0 && tokens + estimate > MAX_BATCH_ESTIMATED_TOKENS)
      )
        break;
      batch.push([id, entry]);
      tokens += estimate;
    }
    return batch;
  }

  #schedule(): void {
    if (this.#inFlight >= this.#limits.maxInFlight) return; // a request in flight schedules the next one
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const batch = this.#nextBatch();
    if (batch.length === 0) return;
    // Full when a bound stopped it: the inputs, or a chunk that did not fit.
    const full = batch.length === MAX_BATCH_INPUTS || batch.length < this.#pending.size;
    const ready = Math.max(
      this.#lastRequestAt + this.#limits.minRequestIntervalMs,
      this.#backoffUntil,
      this.#storeRestUntil,
      full ? Number.NEGATIVE_INFINITY : batch[0][1].queuedAt + MAX_WAIT_MS,
    );
    this.#timer = setTimeout(() => void this.#send(), Math.max(0, ready - Date.now()));
    this.#timer.unref?.();
  }

  async #send(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const batch = this.#nextBatch();
    if (batch.length === 0) return;
    this.#inFlight += 1;
    for (const [id] of batch) this.#pending.delete(id);
    const chunks = batch.map(([, entry]) => entry.chunk);
    this.#lastRequestAt = Date.now();
    // The next request may start while this one is answered.
    this.#schedule();
    try {
      let embeddings: number[][];
      try {
        embeddings = await this.#options.embed(chunks.map(({ text }) => text));
      } catch (error) {
        this.#backOff(error);
        // Back at the head of the queue, ahead of anything queued meanwhile.
        if (retryable(error)) this.#pending = new Map([...batch, ...this.#pending]);
        return;
      }
      this.#consecutiveFailures = 0;
      const storeStartedAt = Date.now();
      try {
        await this.#options.store(chunks, embeddings);
      } catch (error) {
        this.#options.onStoreFailure?.(error, chunks.length);
      } finally {
        this.#restAfterStore(Date.now() - storeStartedAt);
      }
    } finally {
      this.#inFlight -= 1;
      this.#schedule();
    }
  }

  /** Rests as long as a slow store took, so a struggling database is written to at most half the time. */
  #restAfterStore(storeMs: number): void {
    if (storeMs <= this.#limits.slowStoreMs) return;
    this.#storeRestUntil = Math.max(
      this.#storeRestUntil,
      Date.now() + Math.min(storeMs, this.#limits.maxStoreRestMs),
    );
  }

  #backOff(error: unknown): void {
    const floor = Math.min(
      FAILURE_BACKOFF_MS * 2 ** this.#consecutiveFailures,
      MAX_FAILURE_BACKOFF_MS,
    );
    this.#consecutiveFailures += 1;
    this.#backoffUntil = Date.now() + Math.max(statedWait(error), floor);
  }
}
