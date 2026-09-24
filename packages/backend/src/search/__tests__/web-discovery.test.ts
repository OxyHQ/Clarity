import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverWeb } from '../web-discovery.js';

const upstream = vi.fn<typeof fetch>();

function answer(results: unknown[], status = 200): Response {
  return new Response(JSON.stringify({ query: 'q', results }), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  process.env.CLARITY_SEARXNG_URL = 'http://127.0.0.1:8080/';
  upstream.mockReset();
  vi.stubGlobal('fetch', upstream);
});

afterEach(() => {
  delete process.env.CLARITY_SEARXNG_URL;
  vi.unstubAllGlobals();
});

describe('discoverWeb', () => {
  it('asks the sidecar for JSON and keeps each public page once, in the engines order', async () => {
    upstream.mockResolvedValue(answer([
      { url: 'https://www.gsmarena.com/compare.php3?idPhone1=1#specs', title: ' Pixel 10 Pro vs Pixel 11 Pro ', content: 'Side by side.' },
      { url: 'https://www.gsmarena.com/compare.php3?idPhone1=1', title: 'Duplicate after the fragment goes' },
      { url: 'ftp://files.example/pixel.txt', title: 'Not a web page' },
      { url: 'not a url' },
      { url: 'https://www.phonearena.com/compare', title: '', content: '' },
    ]));

    const pages = await discoverWeb({ query: 'Pixel 10 Pro vs Pixel 11 Pro', language: 'es', limit: 10 });

    const requested = new URL(String(upstream.mock.calls[0][0]));
    expect(requested.origin + requested.pathname).toBe('http://127.0.0.1:8080/search');
    expect(requested.searchParams.get('format')).toBe('json');
    expect(requested.searchParams.get('q')).toBe('Pixel 10 Pro vs Pixel 11 Pro');
    expect(requested.searchParams.get('language')).toBe('es');
    expect(pages).toEqual([
      { canonicalUrl: 'https://www.gsmarena.com/compare.php3?idPhone1=1', title: 'Pixel 10 Pro vs Pixel 11 Pro', description: 'Side by side.' },
      { canonicalUrl: 'https://www.phonearena.com/compare', title: undefined, description: undefined },
    ]);
  });

  it('narrows one domain at the engines and filters several itself', async () => {
    upstream.mockImplementation(async () => answer([
      { url: 'https://news.example.com/a' },
      { url: 'https://example.com/b' },
      { url: 'https://other.org/c' },
      { url: 'https://notexample.com/d' },
    ]));
    const one = await discoverWeb({ query: 'pixel', domains: ['Example.com'], limit: 10 });
    expect(new URL(String(upstream.mock.calls[0][0])).searchParams.get('q')).toBe('pixel site:example.com');
    expect(one.map((page) => page.canonicalUrl)).toEqual(['https://news.example.com/a', 'https://example.com/b']);

    const several = await discoverWeb({ query: 'pixel', domains: ['example.com', 'other.org'], limit: 10 });
    expect(new URL(String(upstream.mock.calls[1][0])).searchParams.get('q')).toBe('pixel');
    expect(several.map((page) => page.canonicalUrl)).toEqual(['https://news.example.com/a', 'https://example.com/b', 'https://other.org/c']);
  });

  it('stops at the limit', async () => {
    upstream.mockResolvedValue(answer(Array.from({ length: 30 }, (_, index) => ({ url: `https://site${index}.example/` }))));
    expect(await discoverWeb({ query: 'many', limit: 3 })).toHaveLength(3);
  });

  it('fails open: an error, a refusal or an unknown shape all mean nothing discovered', async () => {
    upstream.mockRejectedValueOnce(new Error('connection refused'));
    expect(await discoverWeb({ query: 'q', limit: 5 })).toEqual([]);
    upstream.mockResolvedValueOnce(answer([], 503));
    expect(await discoverWeb({ query: 'q', limit: 5 })).toEqual([]);
    upstream.mockResolvedValueOnce(new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
    expect(await discoverWeb({ query: 'q', limit: 5 })).toEqual([]);
  });

  it('asks nothing where no sidecar is configured', async () => {
    delete process.env.CLARITY_SEARXNG_URL;
    expect(await discoverWeb({ query: 'q', limit: 5 })).toEqual([]);
    expect(upstream).not.toHaveBeenCalled();
  });
});
