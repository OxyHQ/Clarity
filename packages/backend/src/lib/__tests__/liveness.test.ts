import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLivenessBeat, livenessAgeMs, recordLiveness } from '../liveness.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'liveness-')), 'alive');

describe('liveness', () => {
  it('has no age before the first beat', () => {
    expect(livenessAgeMs(file())).toBeUndefined();
  });

  it('measures the time since the last beat', () => {
    const path = file();
    recordLiveness(path, new Date(Date.now() - 90_000));
    expect(livenessAgeMs(path)).toBeGreaterThanOrEqual(89_000);
    recordLiveness(path);
    expect(livenessAgeMs(path)).toBeLessThan(5_000);
  });

  it('beats at most once per interval', () => {
    const path = file();
    const beat = createLivenessBeat(path);
    beat();
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    beat();
    expect(livenessAgeMs(path)).toBeGreaterThanOrEqual(59_000);
  });
});
