import { describe, expect, it } from 'vitest';

import { clearAbsent } from '../projection.js';

describe('re-projecting a listing', () => {
  it('clears a field the source no longer states instead of keeping the stored value', () => {
    expect(clearAbsent({ title: 'Engineer', salaryMin: undefined, description: undefined, skills: [] }))
      .toEqual({ title: 'Engineer', salaryMin: null, description: null, skills: [] });
  });

  it('keeps every stated value, falsy ones included', () => {
    expect(clearAbsent({ directApply: false, salaryMin: 0, closureReason: null }))
      .toEqual({ directApply: false, salaryMin: 0, closureReason: null });
  });
});
