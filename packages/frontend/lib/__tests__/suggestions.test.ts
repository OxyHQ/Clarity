import { describe, expect, it } from 'vitest';

import { suggestionLanguage, toAliaSuggestion } from '../suggestions';

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

describe('toAliaSuggestion', () => {
  it('offers the prompt, and marks a template so it is finished before sending', () => {
    const base = {
      suggestionId: 'welcome-1',
      title: 'Compare',
      text: 'Compare these two laptops',
      type: 'welcome' as const,
      language: 'en-US',
    };
    expect(toAliaSuggestion({ ...base, isTemplate: false })).toEqual({
      id: 'welcome-1',
      text: 'Compare these two laptops',
    });
    expect(toAliaSuggestion({ ...base, isTemplate: true })).toEqual({
      id: 'welcome-1',
      text: 'Compare these two laptops',
      template: true,
    });
  });
});
