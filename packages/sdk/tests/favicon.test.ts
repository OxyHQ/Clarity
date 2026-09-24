import { describe, expect, it } from 'vitest';

import { resolveFaviconForImageUrl, resolveFaviconUrl } from '../src/favicon.js';

describe('resolveFaviconUrl', () => {
  it('keeps only the normalized hostname', () => {
    expect(resolveFaviconUrl('https://User:secret@Example.COM/private?q=email#thread')).toBe(
      'https://api.clarity.surf/favicons/example.com',
    );
  });

  it('accepts a bare hostname, and another Clarity origin', () => {
    expect(resolveFaviconUrl('news.example.com')).toBe('https://api.clarity.surf/favicons/news.example.com');
    expect(resolveFaviconUrl('news.example.com', { baseUrl: 'http://localhost:3001/' })).toBe(
      'http://localhost:3001/favicons/news.example.com',
    );
  });

  it('rejects invalid and non-http inputs', () => {
    expect(resolveFaviconUrl('')).toBeNull();
    expect(resolveFaviconUrl('mailto:user@example.com')).toBeNull();
    expect(resolveFaviconUrl('not a hostname')).toBeNull();
  });

  it('never names a third-party favicon service', () => {
    expect(resolveFaviconUrl('example.com')).not.toMatch(/google|duckduckgo|icon\.horse/);
  });
});

describe('resolveFaviconForImageUrl', () => {
  it('classifies a conventional root favicon and exposes only its hostname', () => {
    expect(
      resolveFaviconForImageUrl(
        'https://User:secret@Example.COM/favicon.ico?message=user%40example.com#thread',
      ),
    ).toBe('https://api.clarity.surf/favicons/example.com');
  });

  it('matches the conventional path case-insensitively', () => {
    expect(resolveFaviconForImageUrl('https://news.example/FAVICON.ICO')).toBe(
      'https://api.clarity.surf/favicons/news.example',
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
