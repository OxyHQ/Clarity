import { describe, expect, it } from 'vitest';

import { MAX_URL_LENGTH, publicUrlSchema } from '../query-primitives.js';

describe('publicUrlSchema', () => {
  it('canonicalizes a public URL and rejects anything else as a validation issue', () => {
    expect(publicUrlSchema.parse('https://Example.com:443/a#b')).toBe('https://example.com/a');
    for (const value of ['ftp://example.com/', 'https://user:pass@example.com/', 'not a url'])
      expect(publicUrlSchema.safeParse(value).success).toBe(false);
  });
});

describe('MAX_URL_LENGTH', () => {
  // A crawl page's (job_id, url) is a btree key; a 3 kB URL failed its insert
  // as a 500 (index row size 3064 exceeds btree maximum 2704).
  it('rejects a URL too long to be stored, with the reason', () => {
    const base = 'https://example.com/?q=';
    expect(publicUrlSchema.parse(base + 'a'.repeat(MAX_URL_LENGTH - base.length))).toHaveLength(
      MAX_URL_LENGTH,
    );
    const result = publicUrlSchema.safeParse(base + 'a'.repeat(3_000));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(String(MAX_URL_LENGTH));
  });
});
