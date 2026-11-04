import { describe, expect, it } from 'vitest';

import { extractDocument } from '../extractor.js';
import { applyOembed, parseOembed, registeredOembedUrl, wantsOembed } from '../oembed.js';

describe('oEmbed', () => {
  it("finds a registered provider's endpoint, matching the host only as the scheme allows", () => {
    expect(registeredOembedUrl('https://youtu.be/abc?si=1')).toBe(
      `https://www.youtube.com/oembed?url=${encodeURIComponent('https://youtu.be/abc?si=1')}&format=json`,
    );
    expect(registeredOembedUrl('https://m.youtube.com/watch?v=abc')).toMatch(
      /^https:\/\/www\.youtube\.com\/oembed\?/,
    );
    expect(registeredOembedUrl('https://evil.example/?u=.youtube.com/watch')).toBeUndefined();
    expect(registeredOembedUrl('https://example.com/article')).toBeUndefined();
  });

  it('fills what the page did not declare, never reading the embed html', () => {
    const oembed = parseOembed({
      type: 'video',
      title: 'Real title',
      summary: 'Publisher summary',
      provider_name: 'Provider',
      thumbnail_url: 'https://img.example/t.jpg',
      html: '<iframe src="https://evil.example"></iframe><script>alert(1)</script>',
    });
    const page = extractDocument(
      '<html><head><title> - Site</title><meta property="og:description" content="Declared"></head><body></body></html>',
      'https://site.example/watch',
    );
    expect(wantsOembed(page)).toBe(true);
    if (!oembed) throw new Error('Expected oEmbed metadata');
    const merged = applyOembed(page, oembed, 'https://site.example/oembed?url=x');
    expect(merged).toMatchObject({
      title: 'Real title',
      description: 'Declared',
      imageUrl: 'https://img.example/t.jpg',
      publisher: 'Provider',
      documentType: 'video',
    });
    expect(merged.evidence.title).toMatchObject({
      source: 'oembed',
      selector: 'https://site.example',
    });
    expect(JSON.stringify(merged)).not.toMatch(/iframe|<script|evil\.example/);
  });
});
