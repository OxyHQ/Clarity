import { describe, expect, it } from 'vitest';

import { suggestionLanguage } from '../suggestions';

describe('suggestionLanguage', () => {
  it('asks for the pool in the app locale, as the pool stores it', () => {
    expect(suggestionLanguage('es-ES')).toBe('es-ES');
    expect(suggestionLanguage('en_US')).toBe('en-US');
  });

  it('asks for nothing it cannot name exactly', () => {
    expect(suggestionLanguage('es')).toBeUndefined();
    expect(suggestionLanguage('zh-Hant-TW')).toBeUndefined();
  });
});
