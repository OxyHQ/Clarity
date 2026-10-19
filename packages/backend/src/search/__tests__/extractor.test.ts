import { describe, expect, it } from 'vitest';
import { extractDocument } from '../extractor.js';

describe('extractDocument', () => {
  it('extracts canonical metadata, JSON-LD and readable content', () => {
    const result = extractDocument(
      `<!doctype html><html lang="es"><head>
      <title>Fallback</title><meta property="og:title" content="Titular">
      <meta name="description" content="Resumen"><link rel="canonical" href="/article">
      <script type="application/ld+json">{"@type":"NewsArticle","headline":"Titular"}</script>
      </head><body><article><h1>Titular</h1><p>${'Contenido útil. '.repeat(40)}</p></article></body></html>`,
      'https://example.com/source',
    );
    expect(result).toMatchObject({
      title: 'Titular',
      description: 'Resumen',
      canonicalUrl: 'https://example.com/article',
      language: 'es',
      documentType: 'news',
      noindex: false,
    });
    expect(result.mainContent).toContain('Contenido útil');
    expect(result.structuredData).toHaveLength(1);
  });

  it('honours noindex and nofollow', () => {
    const result = extractDocument(
      '<html><head><meta name="robots" content="noindex,nofollow"></head><body>Hidden</body></html>',
      'https://example.com',
    );
    expect(result).toMatchObject({ noindex: true, nofollow: true });
  });

  it('ignores a declared canonical URL too long to be stored', () => {
    const result = extractDocument(
      `<html><head><link rel="canonical" href="/play?state=${'a'.repeat(3_000)}"></head><body>Body</body></html>`,
      'https://example.com/play',
    );
    expect(result.canonicalUrl).toBeUndefined();
  });
});
