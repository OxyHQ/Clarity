import { describe, expect, it } from 'vitest';

import { publicUrlSchema } from '../query-primitives.js';

describe('publicUrlSchema', () => {
  it('canonicalizes a public URL and rejects anything else as a validation issue', () => {
    expect(publicUrlSchema.parse('https://Example.com:443/a#b')).toBe('https://example.com/a');
    for (const value of ['ftp://example.com/', 'https://user:pass@example.com/', 'not a url'])
      expect(publicUrlSchema.safeParse(value).success).toBe(false);
  });
});
