import { describe, expect, it } from 'vitest';

import { resolveFaviconForImageUrl, resolveFaviconUrl } from '../src/favicon.js';

describe('resolveFaviconUrl', () => {
  it('keeps only the normalized hostname', () => {
    expect(resolveFaviconUrl('https://User:secret@Example.COM/private?q=email#thread')).toBe(
      'https://www.google.com/s2/favicons?sz=64&domain_url=example.com',
    );
  });

  it('accepts a bare hostname and a bounded custom size', () => {
    expect(resolveFaviconUrl('news.example.com', 32)).toBe(
      'https://www.google.com/s2/favicons?sz=32&domain_url=news.example.com',
    );
  });

  it('rejects invalid and non-http inputs', () => {
    expect(resolveFaviconUrl('')).toBeNull();
    expect(resolveFaviconUrl('mailto:user@example.com')).toBeNull();
    expect(resolveFaviconUrl('not a hostname')).toBeNull();
  });

  it('falls back to the default size when the requested size is unsafe', () => {
    expect(resolveFaviconUrl('example.com', 1000)).toContain('sz=64');
  });
});

describe('resolveFaviconForImageUrl', () => {
  it('classifies a conventional root favicon and exposes only its hostname', () => {
    expect(
      resolveFaviconForImageUrl(
        'https://User:secret@Example.COM/favicon.ico?message=user%40example.com#thread',
      ),
    ).toBe('https://www.google.com/s2/favicons?sz=64&domain_url=example.com');
  });

  it('matches the conventional path case-insensitively', () => {
    expect(resolveFaviconForImageUrl('https://news.example/FAVICON.ICO', 32)).toBe(
      'https://www.google.com/s2/favicons?sz=32&domain_url=news.example',
    );
  });

  it('does not classify arbitrary icons, relative paths or malformed resources', () => {
    expect(resolveFaviconForImageUrl('https://example.com/assets/favicon.ico')).toBeNull();
    expect(resolveFaviconForImageUrl('/favicon.ico')).toBeNull();
    expect(resolveFaviconForImageUrl('https://cdn.example/logo.svg;a=https://secret.example')).toBeNull();
  });

  it('rejects non-http resources', () => {
    expect(resolveFaviconForImageUrl('data:image/png;base64,abc')).toBeNull();
    expect(resolveFaviconForImageUrl('file:///favicon.ico')).toBeNull();
  });
});
