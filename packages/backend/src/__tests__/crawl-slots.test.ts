import { describe, expect, it } from 'vitest';
import { runCrawlSlots } from '../worker.js';

/**
 * The crawl loop takes several pages at once: a slow site must not hold up the
 * links behind it, a page that throws must not take the others down, and a
 * stop must wait for what is already in flight.
 */
describe('runCrawlSlots', () => {
  function run(pages: number[], process: (page: number) => Promise<void>, concurrency: number) {
    const queue = [...pages];
    let stopping = false;
    const errors: number[] = [];
    const done = runCrawlSlots<number>({
      concurrency,
      isStopping: () => stopping,
      tick: async () => undefined,
      lease: async () => {
        const page = queue.shift();
        if (page === undefined) stopping = true;
        return page;
      },
      process,
      onError: (_error, page) => {
        errors.push(page);
      },
      idleMs: 1,
    });
    return { done, errors };
  }

  it('never runs more pages than the limit, runs them side by side, and survives a failing one', async () => {
    let active = 0;
    let peak = 0;
    const finished: number[] = [];
    const { done, errors } = run(
      [1, 2, 3, 4, 5, 6],
      async (page) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        if (page === 3) throw new Error('fetch exploded');
        finished.push(page);
      },
      3,
    );

    await done;

    expect(peak).toBe(3);
    expect(errors).toEqual([3]);
    expect(finished.sort()).toEqual([1, 2, 4, 5, 6]);
    expect(active).toBe(0);
  });
});
