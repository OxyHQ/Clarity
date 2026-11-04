import { describe, expect, it } from 'vitest';

import { titleFromUrl, urlDocument } from '../url-title.js';

describe('titles from URLs', () => {
  it('reads the headline a path spells, skipping ids, and writes nothing from opaque URLs', () => {
    expect(
      titleFromUrl(
        'https://www.wzzm13.com/article/news/local/grfd-crews-fight-house-fire-on-temple-street-in-grand-rapids/69-ca53102e-ec0e-4e15-9f36-23a0ec26a7ef',
      ),
    ).toBe('Grfd crews fight house fire on temple street in grand rapids');
    expect(
      titleFromUrl(
        'https://www.cbc.ca/news/canada/danny-cleary-community-centre-9.7407278?cmp=rss',
      ),
    ).toBe('Danny cleary community centre');
    expect(titleFromUrl('https://example.com/2026/09/18/tech/google-gemini-ai.html')).toBe(
      'Google gemini ai',
    );
    expect(titleFromUrl('https://www.youtube.com/watch?v=abc')).toBeUndefined();
    expect(
      titleFromUrl('https://example.com/p/01a1a46e-7be1-7ffb-a248-76e5a59daee3'),
    ).toBeUndefined();
    expect(urlDocument('https://www.example.com/a-real-headline-here')).toMatchObject({
      status: 'failed',
      publisher: 'example.com',
      evidence: { title: { source: 'url' } },
    });
  });
});
