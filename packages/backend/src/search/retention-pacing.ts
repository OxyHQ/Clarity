/**
 * When and how fast the retention one-shot works (search/retention.ts): only
 * inside an off-peak window, in batches whose size follows the database's
 * latency, resting between batches like the other paced one-shots.
 *
 * The shared instance (`oxy-postgres`) is IO-bound at its provisioned IOPS, so
 * a delete that slows down is a sign every other product is waiting too: the
 * pacer then pauses and halves the batch, and grows it back only while batches
 * stay fast.
 */

/** Hours of the day, UTC, the job may work in: `[startHour, endHour)`, wrapping past midnight. */
export interface OffPeakWindow {
  startHour: number;
  endHour: number;
}

/** The default window: 01:00–07:00 UTC, the quietest hours on the shared instance. */
export const DEFAULT_OFF_PEAK_WINDOW: OffPeakWindow = { startHour: 1, endHour: 7 };

/** `"1-7"` → 01:00–07:00 UTC; `"always"` → no window. */
export function parseOffPeakWindow(text: string): OffPeakWindow | null {
  if (text === 'always') return null;
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(text);
  const startHour = Number(match?.[1]);
  const endHour = Number(match?.[2]);
  if (
    !match ||
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour > 23 ||
    endHour > 24 ||
    startHour === endHour
  )
    throw new Error(`--window must be "<start>-<end>" in UTC hours (e.g. 1-7) or "always"`);
  return { startHour, endHour };
}

export function insideWindow(window: OffPeakWindow | null, at: Date): boolean {
  if (!window) return true;
  const hour = at.getUTCHours();
  return window.startHour < window.endHour
    ? hour >= window.startHour && hour < window.endHour
    : hour >= window.startHour || hour < window.endHour;
}

/** Milliseconds until the window next opens; 0 inside it. */
export function msUntilWindow(window: OffPeakWindow | null, at: Date): number {
  if (insideWindow(window, at) || !window) return 0;
  const opens = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), window.startHour),
  );
  if (opens.getTime() <= at.getTime()) opens.setUTCDate(opens.getUTCDate() + 1);
  return opens.getTime() - at.getTime();
}

export interface PacingOptions {
  /** The batch size to start at and never exceed. */
  batchSize: number;
  /** The smallest batch the pacer shrinks to. */
  minBatchSize: number;
  /** A batch slower than this pauses the job and halves the next batch. */
  maxBatchMs: number;
  /** How long a slow batch pauses the job. */
  pauseMs: number;
  /** Fraction of wall time spent working; the rest is rest (0 < dutyCycle ≤ 1). */
  dutyCycle: number;
}

export interface PaceDecision {
  batchSize: number;
  restMs: number;
  slowed: boolean;
}

/**
 * Decides the next batch's size and the rest before it from how long the last
 * one took: multiplicative decrease on a slow batch (with a pause), additive
 * increase while batches take under a quarter of the bound.
 */
export class BatchPacer {
  #size: number;

  constructor(private readonly options: PacingOptions) {
    if (!Number.isInteger(options.batchSize) || options.batchSize < 1)
      throw new Error('batchSize must be a positive integer');
    if (!(options.dutyCycle > 0 && options.dutyCycle <= 1))
      throw new Error('dutyCycle must be in (0, 1]');
    this.#size = options.batchSize;
  }

  get batchSize(): number {
    return this.#size;
  }

  next(tookMs: number): PaceDecision {
    const { batchSize, minBatchSize, maxBatchMs, pauseMs, dutyCycle } = this.options;
    const rest = (tookMs * (1 - dutyCycle)) / dutyCycle;
    if (tookMs > maxBatchMs) {
      this.#size = Math.max(Math.min(minBatchSize, batchSize), Math.floor(this.#size / 2));
      return { batchSize: this.#size, restMs: Math.max(rest, pauseMs), slowed: true };
    }
    if (tookMs < maxBatchMs / 4 && this.#size < batchSize)
      this.#size = Math.min(batchSize, this.#size + Math.max(1, Math.floor(batchSize / 10)));
    return { batchSize: this.#size, restMs: rest, slowed: false };
  }
}
