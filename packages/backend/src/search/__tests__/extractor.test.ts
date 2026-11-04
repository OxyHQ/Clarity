import { describe, expect, it } from 'vitest';
import { declaredIconUrl, extractDocument } from '../extractor.js';

describe('extractDocument', () => {
  it('extracts canonical metadata, JSON-LD and readable content', () => {
    const result = extractDocument(
      `<!doctype html><html lang="es"><head>
      <title>Fallback</title><meta property="og:title" content="Titular">
      <meta name="description" content="Resumen"><link rel="canonical" href="/article">
      <meta property="og:url" content="https://example.com/article">
      <meta name="author" content="Meta Writer">
      <script type="application/ld+json">{"@type":"NewsArticle","headline":"Titular","author":[{"@type":"Person","name":"By Ana Ruiz","url":"https://example.com/ana"},"Ana Ruiz","https://example.com/x"]}</script>
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
    expect(result.authors).toEqual([{ name: 'Ana Ruiz', url: 'https://example.com/ana' }]);
    expect(result.mainContent).toContain('Contenido útil');
    expect(result.structuredData).toHaveLength(1);
  });

  it('reads markup that opens before its root, declared metadata first, and only a canonical naming this page', () => {
    const result = extractDocument(
      `\n  <!DOCTYPE html>\n<html><head><title>Watch - Site</title>
      <meta name="twitter:title" content="Card title"><meta name="description" content="Meta summary">
      <link rel="canonical" href="https://example.com/undefined">
      <link rel="alternate" type="application/json+oembed" href="/oembed?url=x">
      <script type="application/ld+json">{"@type":"VideoObject","name":"Video","thumbnailUrl":"/thumb.jpg"}</script>
      </head><body><p>Body</p></body></html>`,
      'https://www.example.com/watch?v=1',
    );
    expect(result).toMatchObject({
      title: 'Card title',
      description: 'Meta summary',
      imageUrl: 'https://www.example.com/thumb.jpg',
      oembedUrl: 'https://www.example.com/oembed?url=x',
      canonicalUrl: undefined,
    });
    expect(result.evidence.title).toMatchObject({ selector: 'meta[name="twitter:title"]' });
    expect(result.evidence.imageUrl).toMatchObject({ source: 'json_ld' });
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
