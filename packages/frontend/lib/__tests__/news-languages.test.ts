import { describe, expect, it } from 'vitest';

import { newsLanguagesFor } from '../news-languages';

describe('newsLanguagesFor', () => {
  it('asks for the reader\'s language, then English, once each', () => {
    expect(newsLanguagesFor('es-ES')).toEqual(['es', 'en']);
    expect(newsLanguagesFor('en_US')).toEqual(['en']);
    expect(newsLanguagesFor(undefined)).toEqual(['en']);
  });
});
