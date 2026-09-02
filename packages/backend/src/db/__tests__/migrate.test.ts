import { describe, expect, it } from 'vitest';

import { isDryRun, readPhase } from '../migrate.js';

describe('migration CLI guards', () => {
  it('requires an explicit deployment phase', () => {
    expect(() => readPhase([])).toThrow('--phase is required');
    expect(() => readPhase(['--phase=unsafe'])).toThrow('Unknown phase');
  });

  it('accepts only supported phases and explicit dry-run', () => {
    expect(readPhase(['--phase=pre'])).toBe('pre');
    expect(readPhase(['--phase=post'])).toBe('post');
    expect(readPhase(['--phase=all'])).toBe('all');
    expect(isDryRun(['--dry-run'])).toBe(true);
    expect(isDryRun([])).toBe(false);
  });
});
