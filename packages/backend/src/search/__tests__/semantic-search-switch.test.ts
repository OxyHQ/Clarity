import { describe, expect, it } from 'vitest';

import { semanticSearchEnabled } from '../semantic-search-switch.js';

describe('semanticSearchEnabled', () => {
  it('is on by default: unset, empty or any other value changes nothing', () => {
    expect(semanticSearchEnabled({})).toBe(true);
    expect(semanticSearchEnabled({ CLARITY_SEMANTIC_SEARCH: '' })).toBe(true);
    expect(semanticSearchEnabled({ CLARITY_SEMANTIC_SEARCH: 'on' })).toBe(true);
    expect(semanticSearchEnabled({ CLARITY_SEMANTIC_SEARCH: 'false' })).toBe(true);
    expect(semanticSearchEnabled({ CLARITY_SEMANTIC_SEARCH: 'of' })).toBe(true);
  });

  it('is off only for `off`, whatever its case or surrounding space', () => {
    expect(semanticSearchEnabled({ CLARITY_SEMANTIC_SEARCH: 'off' })).toBe(false);
    expect(semanticSearchEnabled({ CLARITY_SEMANTIC_SEARCH: ' OFF\n' })).toBe(false);
  });
});
