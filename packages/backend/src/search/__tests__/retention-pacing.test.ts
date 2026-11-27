import { describe, expect, it } from 'vitest';

import { parseRetentionArguments } from '../../scripts/search-retention.js';
import {
  BatchPacer,
  DEFAULT_OFF_PEAK_WINDOW,
  insideWindow,
  msUntilWindow,
  parseOffPeakWindow,
} from '../retention-pacing.js';

const at = (iso: string) => new Date(iso);

describe('the off-peak window', () => {
  it('defaults to 01:00–07:00 UTC', () => {
    expect(DEFAULT_OFF_PEAK_WINDOW).toEqual({ startHour: 1, endHour: 7 });
    expect(insideWindow(DEFAULT_OFF_PEAK_WINDOW, at('2026-11-28T00:59:59Z'))).toBe(false);
    expect(insideWindow(DEFAULT_OFF_PEAK_WINDOW, at('2026-11-28T01:00:00Z'))).toBe(true);
    expect(insideWindow(DEFAULT_OFF_PEAK_WINDOW, at('2026-11-28T06:59:59Z'))).toBe(true);
    expect(insideWindow(DEFAULT_OFF_PEAK_WINDOW, at('2026-11-28T07:00:00Z'))).toBe(false);
  });

  it('wraps past midnight', () => {
    const window = parseOffPeakWindow('22-4');
    expect(insideWindow(window, at('2026-11-28T23:00:00Z'))).toBe(true);
    expect(insideWindow(window, at('2026-11-28T03:00:00Z'))).toBe(true);
    expect(insideWindow(window, at('2026-11-28T12:00:00Z'))).toBe(false);
  });

  it('waits until it next opens', () => {
    expect(msUntilWindow(DEFAULT_OFF_PEAK_WINDOW, at('2026-11-28T02:00:00Z'))).toBe(0);
    expect(msUntilWindow(DEFAULT_OFF_PEAK_WINDOW, at('2026-11-28T00:30:00Z'))).toBe(30 * 60_000);
    expect(msUntilWindow(DEFAULT_OFF_PEAK_WINDOW, at('2026-11-28T08:00:00Z'))).toBe(17 * 3_600_000);
    expect(msUntilWindow(null, at('2026-11-28T12:00:00Z'))).toBe(0);
  });

  it('rejects a window it cannot read', () => {
    expect(parseOffPeakWindow('always')).toBeNull();
    for (const text of ['1', '7-7', '25-3', 'night'])
      expect(() => parseOffPeakWindow(text)).toThrow();
  });
});

describe('the batch pacer', () => {
  const options = { batchSize: 200, minBatchSize: 25, maxBatchMs: 2_000, pauseMs: 60_000 };

  it('rests as long as it works at a duty cycle of one half', () => {
    const pacer = new BatchPacer({ ...options, dutyCycle: 0.5 });
    expect(pacer.next(800)).toEqual({ batchSize: 200, restMs: 800, slowed: false });
  });

  it('pauses and halves the batch when one is slow, down to the floor', () => {
    const pacer = new BatchPacer({ ...options, dutyCycle: 0.5 });
    expect(pacer.next(5_000)).toEqual({ batchSize: 100, restMs: 60_000, slowed: true });
    expect(pacer.next(5_000).batchSize).toBe(50);
    expect(pacer.next(5_000).batchSize).toBe(25);
    expect(pacer.next(5_000).batchSize).toBe(25);
  });

  it('grows back only while batches stay fast', () => {
    const pacer = new BatchPacer({ ...options, dutyCycle: 1 });
    pacer.next(5_000);
    expect(pacer.batchSize).toBe(100);
    expect(pacer.next(1_000).batchSize).toBe(100);
    expect(pacer.next(100).batchSize).toBe(120);
    for (let i = 0; i < 10; i += 1) pacer.next(100);
    expect(pacer.batchSize).toBe(200);
  });
});

describe('the retention one-shot arguments', () => {
  const url = 'postgresql://user@db.example/clarity';

  it('is a dry run by default, in the off-peak window, at 30 days', () => {
    const parsed = parseRetentionArguments(['--target-database=clarity', '--target=crawl'], url);
    expect(parsed).toMatchObject({
      target: 'crawl',
      days: 30,
      execute: false,
      includeStale: false,
      window: DEFAULT_OFF_PEAK_WINDOW,
    });
  });

  it('refuses to delete without the database named as confirmation', () => {
    const base = ['--target-database=clarity', '--target=job-documents', '--execute'];
    expect(() => parseRetentionArguments(base, url)).toThrow(/confirm-delete=clarity/);
    expect(() => parseRetentionArguments([...base, '--confirm-delete=clarity_ci'], url)).toThrow();
    expect(parseRetentionArguments([...base, '--confirm-delete=clarity'], url).execute).toBe(true);
  });

  it('refuses a database other than the one named, and an unknown target', () => {
    expect(() =>
      parseRetentionArguments(['--target-database=clarity_ci', '--target=crawl'], url),
    ).toThrow(/target-database/);
    expect(() =>
      parseRetentionArguments(['--target-database=clarity', '--target=usage-events'], url),
    ).toThrow(/--target/);
  });
});
