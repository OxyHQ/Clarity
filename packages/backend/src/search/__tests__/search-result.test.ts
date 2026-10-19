import { describe, expect, it } from 'vitest';

import type { DocumentCardRow } from '../public-document.js';
import { searchResult } from '../public-document.js';

const row = {
  id: 'document-1',
  canonicalUrl: 'https://example.com/a',
  requestedUrl: 'https://example.com/a',
  title: 'A page',
  description: null,
  mainContent: `${'Opening words. '.repeat(10)}${'more '.repeat(200)}`,
  documentType: 'article',
  status: 'indexed',
  fieldEvidence: {},
} as unknown as DocumentCardRow;

describe('searchResult', () => {
  // The SDK's SearchResult has never carried the page text; a search read and
  // sent up to 5 MB of it per result to cut a 300-character snippet.
  it('carries a snippet, never the page text', () => {
    const result = searchResult(row, 0.5, new Set());
    expect(result).not.toHaveProperty('content');
    expect(result.snippet).toMatch(/^Opening words\./);
    expect(result.snippet?.length).toBeLessThanOrEqual(301);
    expect(result).toMatchObject({ id: 'document-1', title: 'A page', score: 0.5 });
  });

  it('prefers the description as the snippet', () => {
    expect(searchResult({ ...row, description: 'Described.' }, 1, new Set()).snippet).toBe(
      'Described.',
    );
  });
});
