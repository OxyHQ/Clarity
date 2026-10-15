/**
 * Clarity's embeddings: `POST https://kaana.ai/v1/embeddings` through
 * `@kaana.ai/sdk`, authenticated by Clarity's Oxy service token for the
 * `kaana.ai` audience (Kaana ADR 0002, decisions 6 and 7).
 *
 * ## A capability, not an assumption
 *
 * Embeddings exist only where the deployment says Kaana serves Clarity's
 * embedding model: `CLARITY_EMBEDDINGS_ENABLED=true`. Without it nothing here is
 * called at all — chunks are stored unembedded (`documentChunkState` reports
 * them `unembedded`, so they are embedded on a later pass once the capability
 * is on), and search ranks lexically and says so in `degraded`.
 *
 * Kaana's catalogue is not the switch: it is DECLARED (`GET /v1/models` lists
 * what Kaana may offer), not a statement that a provider key is live for this
 * model, so it cannot say whether a call would be served.
 *
 * ## Failures
 *
 * With the capability on, a failed call (a typed `KaanaError`, a timeout, a
 * malformed answer) is reported at most once per {@link FAILURE_REPORT_INTERVAL_MS}
 * with the number of failures since the last report, never once per document,
 * and the caller degrades exactly as it does without the capability.
 */
import { Kaana, KaanaError } from '@kaana.ai/sdk';

import { getClarityServiceTokenFor } from './clarity-service-auth.js';
import { createLogger } from './logger.js';

export const CLARITY_EMBEDDING_MODEL = 'qwen/qwen3-embedding-0.6b';
export const CLARITY_EMBEDDING_DIMENSION = 1024;

/** `@kaana.ai/contracts` `MAX_EMBEDDING_INPUTS`. */
const MAX_EMBEDDING_INPUTS = 2048;
const DEFAULT_TIMEOUT_MS = 30_000;
export const FAILURE_REPORT_INTERVAL_MS = 5 * 60_000;

const log = createLogger('embeddings');

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

let reportedDisabled = false;

/**
 * Whether this deployment has an embeddings route. Off unless
 * `CLARITY_EMBEDDINGS_ENABLED` is exactly `true`; the first time it is asked
 * and the answer is no, it says so once.
 */
export function embeddingsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLARITY_EMBEDDINGS_ENABLED === 'true') return true;
  if (!reportedDisabled) {
    reportedDisabled = true;
    log.info(
      { model: CLARITY_EMBEDDING_MODEL },
      'Embeddings are off (CLARITY_EMBEDDINGS_ENABLED is not true): search is lexical and chunks are stored unembedded',
    );
  }
  return false;
}

let lastReportedAt = Number.NEGATIVE_INFINITY;
let unreportedFailures = 0;

function reportFailure(error: unknown): void {
  unreportedFailures += 1;
  const now = Date.now();
  if (now - lastReportedAt < FAILURE_REPORT_INTERVAL_MS) return;
  log.warn(
    {
      model: CLARITY_EMBEDDING_MODEL,
      failures: unreportedFailures,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof KaanaError
        ? { code: error.code, status: error.status, requestId: error.requestId }
        : {}),
    },
    'Kaana embeddings call failed; search degrades to lexical and chunks stay unembedded',
  );
  lastReportedAt = now;
  unreportedFailures = 0;
}

/** Test seam: forget what has been reported. */
export function resetEmbeddingReportsForTests(): void {
  reportedDisabled = false;
  lastReportedAt = Number.NEGATIVE_INFINITY;
  unreportedFailures = 0;
}

let defaultClient: Kaana | undefined;

function kaana(): Kaana {
  defaultClient ??= new Kaana({
    credential: () => getClarityServiceTokenFor('kaana.ai'),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  return defaultClient;
}

export interface EmbeddingOptions {
  signal?: AbortSignal;
  /** The client to call; Clarity's own (service token, `https://kaana.ai/v1`) when absent. */
  client?: Pick<Kaana, 'embeddings'>;
}

/**
 * One vector per input, in input order. Callers ask {@link embeddingsEnabled}
 * first; this always calls Kaana.
 */
export async function createEmbeddings(
  input: readonly string[],
  options: EmbeddingOptions = {},
): Promise<number[][]> {
  if (input.length === 0) return [];
  if (input.length > MAX_EMBEDDING_INPUTS)
    throw new EmbeddingError(`Kaana embeds at most ${MAX_EMBEDDING_INPUTS} inputs per request`);
  try {
    const response = await (options.client ?? kaana()).embeddings.create(
      {
        model: CLARITY_EMBEDDING_MODEL,
        input: [...input],
        dimensions: CLARITY_EMBEDDING_DIMENSION,
        encoding_format: 'float',
      },
      options.signal ? { signal: options.signal } : undefined,
    );
    // `model` names the revision that served; the line must be the one requested.
    if (response.model.split('@')[0] !== CLARITY_EMBEDDING_MODEL)
      throw new EmbeddingError(`Kaana answered with ${response.model}`);
    if (response.data.length !== input.length)
      throw new EmbeddingError('Kaana returned a vector count that does not match the input');
    const ordered = [...response.data].sort((left, right) => left.index - right.index);
    if (ordered.some((item, index) => item.index !== index))
      throw new EmbeddingError('Kaana returned non-contiguous embedding indexes');
    if (ordered.some((item) => item.embedding.length !== CLARITY_EMBEDDING_DIMENSION))
      throw new EmbeddingError(
        `Kaana returned vectors that are not ${CLARITY_EMBEDDING_DIMENSION}-dimensional`,
      );
    return ordered.map((item) => item.embedding);
  } catch (error) {
    reportFailure(error);
    throw error;
  }
}
