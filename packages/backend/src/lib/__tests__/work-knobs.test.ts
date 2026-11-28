import { describe, expect, it } from 'vitest';

import { BACKLOG_BATCH } from '../../search/chunking.js';
import {
  MAX_IN_FLIGHT,
  MAX_STORE_REST_MS,
  MIN_REQUEST_INTERVAL_MS,
  SLOW_STORE_MS,
} from '../../search/embedding-queue.js';
import {
  heavyHoursGate,
  inHeavyHours,
  inHourRanges,
  integerKnob,
  parseHourRanges,
} from '../work-knobs.js';

const at = (hour: number) => new Date(Date.UTC(2026, 10, 28, hour, 30));

describe('work knobs', () => {
  it('keeps the built-in pace when no knob is set', () => {
    expect({
      MAX_IN_FLIGHT,
      MIN_REQUEST_INTERVAL_MS,
      BACKLOG_BATCH,
      SLOW_STORE_MS,
      MAX_STORE_REST_MS,
    }).toEqual({
      MAX_IN_FLIGHT: 2,
      MIN_REQUEST_INTERVAL_MS: 2_000,
      BACKLOG_BATCH: 2_048,
      SLOW_STORE_MS: 2_000,
      MAX_STORE_REST_MS: 60_000,
    });
    for (let hour = 0; hour < 24; hour += 1) expect(inHeavyHours(at(hour))).toBe(true);
  });

  it('reads an integer knob within its bounds, and falls back on anything else', () => {
    const bounds = { min: 1, max: 8 };
    expect(integerKnob({ K: '4' }, 'K', 2, bounds)).toBe(4);
    expect(integerKnob({ K: ' 8 ' }, 'K', 2, bounds)).toBe(8);
    for (const raw of [undefined, '', '0', '9', '-1', '1.5', '2x', 'two', '1e3'])
      expect(integerKnob({ K: raw }, 'K', 2, bounds)).toBe(2);
  });

  it('parses UTC hour ranges, end exclusive, wrapping past midnight', () => {
    expect(parseHourRanges('1-6')).toEqual([[1, 6]]);
    expect(parseHourRanges('22-4, 13-14')).toEqual([
      [22, 4],
      [13, 14],
    ]);
    expect(parseHourRanges('0-24')).toEqual([[0, 24]]);
    for (const raw of ['', '3-3', '1-25', '24-2', '1', '1-6;7-8', 'night', '1-6,'])
      expect(parseHourRanges(raw)).toBeNull();

    const night = parseHourRanges('1-6') ?? [];
    expect([0, 1, 5, 6, 12].map((hour) => inHourRanges(night, at(hour)))).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
    const wrapped = parseHourRanges('22-4') ?? [];
    expect([21, 22, 23, 0, 3, 4].map((hour) => inHourRanges(wrapped, at(hour)))).toEqual([
      false,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it('opens the heavy-hours gate around the clock unless it is set and parses', () => {
    expect(heavyHoursGate({}).state).toBe('always');
    const invalid = heavyHoursGate({ CLARITY_HEAVY_HOURS_UTC: 'nights' });
    expect(invalid.state).toBe('invalid');
    expect(invalid.open(at(12))).toBe(true);
    const night = heavyHoursGate({ CLARITY_HEAVY_HOURS_UTC: '1-6' });
    expect(night.state).toBe('ranges');
    expect(night.open(at(2))).toBe(true);
    expect(night.open(at(12))).toBe(false);
  });
});
