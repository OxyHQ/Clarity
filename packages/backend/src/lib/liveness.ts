/**
 * The crawl worker's liveness signal, read by its ECS health check.
 *
 * The worker is one event loop. When that loop stops turning (a page it cannot
 * finish, a wait that never ends) nothing inside the process can notice, and
 * ECS keeps reporting the task as running: the crawl worker once sat frozen for
 * hours with 10,000 pages queued. The crawl loop therefore records a heartbeat
 * as the mtime of a file, and `healthcheck.ts` — a separate process — fails
 * when that mtime is too old, so ECS replaces the task.
 */
import { closeSync, openSync, statSync, utimesSync } from 'node:fs';

export const LIVENESS_FILE = process.env.CLARITY_LIVENESS_FILE || '/tmp/clarity-worker.alive';

/**
 * Longest silence a healthy worker may have. The loop beats between every
 * maintenance step and at least once a second while crawling, so ten minutes
 * leaves room for the slowest sweep without hiding a frozen loop.
 */
export const LIVENESS_MAX_AGE_MS =
  (Number.parseInt(process.env.CLARITY_LIVENESS_MAX_AGE_SECONDS ?? '', 10) || 600) * 1000;

/** Writing more often than this adds nothing: the limit is minutes. */
const MIN_BEAT_INTERVAL_MS = 5_000;

export function recordLiveness(file = LIVENESS_FILE, now = new Date()): void {
  closeSync(openSync(file, 'a'));
  utimesSync(file, now, now);
}

/** A beat function that touches the file at most once per interval. */
export function createLivenessBeat(file = LIVENESS_FILE): () => void {
  let last = 0;
  return () => {
    const now = Date.now();
    if (now - last < MIN_BEAT_INTERVAL_MS) return;
    last = now;
    recordLiveness(file, new Date(now));
  };
}

/** Milliseconds since the last beat, or `undefined` when there has been none. */
export function livenessAgeMs(file = LIVENESS_FILE, now = Date.now()): number | undefined {
  try {
    return now - statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}
