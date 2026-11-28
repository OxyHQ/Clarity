/**
 * Operator knobs for the worker's database-heavy background work, read from
 * the environment once at start-up. Every knob is optional: unset (or
 * unreadable) means the built-in default, so a deploy without them behaves
 * exactly as before.
 *
 * - `EMBED_MAX_IN_FLIGHT`, `EMBED_MIN_REQUEST_INTERVAL_MS`, `EMBED_BACKLOG_BATCH`,
 *   `SLOW_STORE_MS`, `MAX_STORE_REST_MS`: the embedding queue's pace
 *   (search/embedding-queue.ts, search/chunking.ts).
 * - `CLARITY_HEAVY_HOURS_UTC`: the UTC hours in which the embedding backlog
 *   sweep and the job retention prune run, for example `1-6` (01:00 up to
 *   06:00) or `22-4,13-14`. Unset, they run around the clock.
 */

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * An integer knob within `[min, max]`. Unset, empty, not an integer or out of
 * range: the default. A typo must never stop the worker or make it race.
 */
export function integerKnob(
  env: Env,
  name: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= bounds.min && value <= bounds.max
    ? value
    : fallback;
}

/** UTC hours as half-open ranges `[start, end)`; `start > end` wraps past midnight. */
export type HourRanges = readonly (readonly [start: number, end: number])[];

/**
 * Parses `1-6`, `22-4` or `1-6,13-14` (UTC hours 0–24, end exclusive). Returns
 * `null` for anything else, including an empty range such as `3-3`.
 */
export function parseHourRanges(value: string): HourRanges | null {
  const ranges: [number, number][] = [];
  for (const part of value.split(',')) {
    const match = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(part);
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start > 23 || end > 24 || start === end) return null;
    ranges.push([start, end]);
  }
  return ranges.length > 0 ? ranges : null;
}

/** Whether `date`'s UTC hour falls in one of the ranges. */
export function inHourRanges(ranges: HourRanges, date: Date): boolean {
  const hour = date.getUTCHours();
  return ranges.some(([start, end]) =>
    start < end ? hour >= start && hour < end : hour >= start || hour < end,
  );
}

/**
 * The heavy-hours gate from `CLARITY_HEAVY_HOURS_UTC`: `always` when unset,
 * `invalid` (and open around the clock, as before) when it does not parse, so
 * the caller can log it once.
 */
export function heavyHoursGate(env: Env): {
  state: 'always' | 'invalid' | 'ranges';
  open: (date?: Date) => boolean;
} {
  const raw = env.CLARITY_HEAVY_HOURS_UTC?.trim();
  if (!raw) return { state: 'always', open: () => true };
  const ranges = parseHourRanges(raw);
  if (!ranges) return { state: 'invalid', open: () => true };
  return { state: 'ranges', open: (date = new Date()) => inHourRanges(ranges, date) };
}

const gate = heavyHoursGate(process.env);

/** Whether heavy background work may run now (`CLARITY_HEAVY_HOURS_UTC`). */
export function inHeavyHours(date?: Date): boolean {
  return gate.open(date);
}

/** How the heavy-hours gate was configured, for the worker's start-up log line. */
export const heavyHoursState = gate.state;
