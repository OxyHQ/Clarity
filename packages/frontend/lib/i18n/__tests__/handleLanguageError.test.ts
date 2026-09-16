import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleLanguageError } from '../handleLanguageError';

/**
 * `OxyProvider`'s `language` config reports a failed `onChange` here instead
 * of throwing into render — a missing catalog entry for the resolved locale
 * must not take the whole app tree down over a chrome-language mismatch.
 */
describe('handleLanguageError', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('logs the failure with the locale that failed to load, never throws', () => {
    const failure = new Error('missing catalog entry');

    expect(() => handleLanguageError(failure, 'es-ES')).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      '[i18n] Failed to follow the Oxy-resolved language',
      failure,
      { locale: 'es-ES' },
    );
  });
});
