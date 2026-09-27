import { describe, expect, it } from 'vitest';

import { dateFromUrl, metadataFromStructuredData, plausibleDate } from '../article-metadata.js';
import { extractDocument } from '../extractor.js';

const NOW = Date.parse('2026-09-27T12:00:00Z');

describe('article metadata', () => {
  it('reads the article node first, including one nested in @graph', () => {
    expect(metadataFromStructuredData([{
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', datePublished: '2001-01-01', publisher: { name: 'Site' } },
        { '@type': ['NewsArticle'], datePublished: '2026-09-25T08:30:00+02:00', dateModified: '2026-09-26T10:00:00Z', publisher: [{ '@type': 'Organization', name: 'Le Monde' }] },
      ],
    }], NOW)).toEqual({
      publishedAt: new Date('2026-09-25T06:30:00Z'),
      modifiedAt: new Date('2026-09-26T10:00:00Z'),
      publisher: 'Le Monde',
    });
  });

  it('refuses dates that are not dates, or implausible ones', () => {
    expect(plausibleDate('yesterday', NOW)).toBeUndefined();
    expect(plausibleDate('2026-13-45', NOW)).toBeUndefined();
    expect(plausibleDate('1970-01-01', NOW)).toBeUndefined();
    expect(plausibleDate('2027-01-01', NOW)).toBeUndefined();
  });

  it('reads a full date written into the URL path, numeric or by month name', () => {
    expect(dateFromUrl('https://www.lemonde.fr/politique/article/2026/09/25/x_1.html', NOW)).toEqual(new Date('2026-09-25T00:00:00Z'));
    expect(dateFromUrl('https://www.theguardian.com/us-news/2026/jul/30/story', NOW)).toEqual(new Date('2026-07-30T00:00:00Z'));
    expect(dateFromUrl('https://arstechnica.com/health/2023/11/ai-story/', NOW)).toBeUndefined();
    expect(dateFromUrl('https://example.com/2026/02/31/not-a-day', NOW)).toBeUndefined();
  });

  it('is what the extractor stores, with meta tags and the URL as fallbacks', () => {
    const page = (head: string) => `<html lang="de-DE"><head>${head}</head><body><article><p>${'Text. '.repeat(40)}</p></article></body></html>`;
    expect(extractDocument(page('<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-09-20T10:00:00Z","publisher":{"name":"heise"}}</script>'), 'https://heise.de/a'))
      .toMatchObject({ publishedAt: new Date('2026-09-20T10:00:00Z'), publisher: 'heise', language: 'de-DE' });
    expect(extractDocument(page('<meta property="article:published_time" content="2026-09-21T10:00:00Z"><meta property="og:site_name" content="SPIEGEL">'), 'https://spiegel.de/a'))
      .toMatchObject({ publishedAt: new Date('2026-09-21T10:00:00Z'), publisher: 'SPIEGEL' });
    expect(extractDocument(page(''), 'https://example.com/news/2026/09/22/story').publishedAt).toEqual(new Date('2026-09-22T00:00:00Z'));
    expect(extractDocument(page(''), 'https://example.com/story').publishedAt).toBeUndefined();
  });
});
