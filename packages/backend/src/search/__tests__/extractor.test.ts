import { describe, expect, it } from 'vitest';
import { declaredIconUrl, extractDocument } from '../extractor.js';

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

describe('declaredIconUrl', () => {
  it("reads the icon from the page's head, as extractDocument does", () => {
    const html = `<html><head><link rel="shortcut icon" href="/brand.png"></head><body>${'<p>Body</p>'.repeat(50)}<link rel="icon" href="/body.png"></body></html>`;
    expect(declaredIconUrl(html, 'https://example.com/')).toBe('https://example.com/brand.png');
    expect(declaredIconUrl(html, 'https://example.com/')).toBe(
      extractDocument(html, 'https://example.com/').faviconUrl,
    );
    expect(declaredIconUrl('<html><head></head><body></body></html>', 'https://example.com/')).toBe(
      undefined,
    );
  });
});
