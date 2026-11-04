import { describe, expect, it } from 'vitest';

import { resourceUrl } from '../resource-url.js';

describe('resourceUrl', () => {
  it("names a resource by its URL without tracking, in its provider's canonical form", () => {
    const watch = 'https://www.youtube.com/watch?v=abcdefghijk';
    for (const variant of [
      `${watch}&t=2s`,
      'https://youtu.be/abcdefghijk?si=share',
      'https://m.youtube.com/watch?v=abcdefghijk&list=PL1#t=5',
      'https://www.youtube.com/live/abcdefghijk',
    ])
      expect(resourceUrl(variant)).toBe(watch);
    expect(resourceUrl('https://News.example/a?id=7&utm_source=x&fbclid=y')).toBe(
      'https://news.example/a?id=7',
    );
    expect(resourceUrl('https://forum.example/viewtopic.php?t=12')).toBe(
      'https://forum.example/viewtopic.php?t=12',
    );
  });
});
