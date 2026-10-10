import { describe, expect, it } from 'vitest';

import {
  JOB_STALE_AFTER_DAYS,
  jobLifecycleStatus,
  JOB_FEED_STALE_AFTER_DAYS,
} from '../lifecycle.js';

const now = new Date('2026-09-09T00:00:00.000Z');
const days = (count: number) => new Date(now.getTime() - count * 24 * 60 * 60 * 1000);

describe('job lifecycle policy', () => {
  it('keeps a recently seen listing with a future expiry active', () => {
    expect(
      jobLifecycleStatus({
        validThrough: new Date('2026-10-01T00:00:00.000Z'),
        lastSeenAt: days(1),
        now,
      }),
    ).toBe('active');
  });

  it('expires a listing the moment its declared validThrough passes', () => {
    expect(jobLifecycleStatus({ validThrough: days(1), lastSeenAt: days(1), now })).toBe('expired');
    expect(jobLifecycleStatus({ validThrough: now, lastSeenAt: days(1), now })).toBe('expired');
  });

  it('honours an explicit expiry even when the listing is still crawled', () => {
    expect(jobLifecycleStatus({ validThrough: days(2), lastSeenAt: now, now })).toBe('expired');
  });

  it('degrades an unexpiring listing to stale only after the documented window', () => {
    expect(jobLifecycleStatus({ lastSeenAt: days(JOB_STALE_AFTER_DAYS - 1), now })).toBe('active');
    expect(jobLifecycleStatus({ lastSeenAt: days(JOB_STALE_AFTER_DAYS + 1), now })).toBe('stale');
    // A feed re-delivers its listings every few hours, so its silence counts sooner.
    expect(
      jobLifecycleStatus({
        lastSeenAt: days(JOB_FEED_STALE_AFTER_DAYS - 1),
        sourceType: 'feed',
        now,
      }),
    ).toBe('active');
    expect(
      jobLifecycleStatus({
        lastSeenAt: days(JOB_FEED_STALE_AFTER_DAYS + 1),
        sourceType: 'feed',
        now,
      }),
    ).toBe('stale');
    expect(
      jobLifecycleStatus({
        lastSeenAt: days(JOB_FEED_STALE_AFTER_DAYS + 1),
        sourceType: 'web',
        now,
      }),
    ).toBe('active');
  });

  it('reports a withdrawn listing as closed and a removed document as removed', () => {
    expect(jobLifecycleStatus({ lastSeenAt: now, closedAt: days(1), now })).toBe('closed');
    expect(jobLifecycleStatus({ lastSeenAt: now, documentStatus: 'removed', now })).toBe('removed');
    expect(jobLifecycleStatus({ lastSeenAt: now, documentStatus: 'blocked', now })).toBe('removed');
    expect(
      jobLifecycleStatus({ lastSeenAt: now, closedAt: days(1), documentStatus: 'removed', now }),
    ).toBe('removed');
  });
});
