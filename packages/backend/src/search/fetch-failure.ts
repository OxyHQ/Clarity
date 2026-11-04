/**
 * Why a page fetch ended without a page, and whether asking again can change it.
 *
 * A transient failure — the site is rate limiting (429), erroring (5xx) or
 * unreachable for now (timeouts, resets, refused connections) — is retried with
 * backoff and reported to readers as retryable. Anything else is the site's
 * answer about this URL (401/403 and other refusals, an unsupported content
 * type, a body too large, a name that does not resolve): retrying it minutes
 * later only spends fetches, so it fails on the first attempt.
 */
import { isAbortError, isTransientNetworkError } from '../lib/error-classification.js';

/** A fetch that reached the site but got no usable page. */
export class PageFetchError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'PageFetchError';
  }
}

/** Statuses that say "not now" rather than "no". */
function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** `safeFetch` and the body reader report these as messages, not error codes. */
const TRANSIENT_MESSAGE =
  /timed? ?out|timeout|deadline|aborted|socket hang up|socket is closed|econnreset|econnrefused|response closed before/i;

export function isTransientFetchFailure(error: unknown): boolean {
  if (error instanceof PageFetchError)
    return error.httpStatus !== undefined && transientStatus(error.httpStatus);
  if (isTransientNetworkError(error) || isAbortError(error)) return true;
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  return error instanceof Error && TRANSIENT_MESSAGE.test(error.message);
}
