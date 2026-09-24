import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeFetch = vi.hoisted(() => vi.fn());
vi.mock('@oxy.so/core/server', () => ({ safeFetch }));

import { isPublicHostname } from '../../routes/favicons.js';
import { fetchSiteIcon, hostOf, siteIconUrl, sniffImageType } from '../site-icons.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);

/** A `safeFetch` result for one URL. */
function answer(status: number, body: Buffer | string, finalUrl: string) {
  return { status, headers: {}, finalUrl, response: Readable.from([Buffer.from(body)]) };
}

describe('sniffImageType', () => {
  it('names an image by its bytes, whatever the site labelled it', () => {
    expect(sniffImageType(ICO)).toBe('image/x-icon');
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(Buffer.from('GIF89a...'))).toBe('image/gif');
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(Buffer.from('  <svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml');
    expect(sniffImageType(Buffer.from('<?xml version="1.0"?><svg></svg>'))).toBe('image/svg+xml');
  });

  it('refuses what is not an image — an HTML error page served as the icon above all', () => {
    expect(sniffImageType(Buffer.from('<!doctype html><title>Not found</title>'))).toBeUndefined();
    expect(sniffImageType(Buffer.from(''))).toBeUndefined();
  });
});

describe('hosts', () => {
  it('reads the host of a public HTTP(S) URL only', () => {
    expect(hostOf('https://WWW.GSMArena.com/compare.php3?x=1')).toBe('www.gsmarena.com');
    expect(hostOf('ftp://files.example/icon.ico')).toBeUndefined();
    expect(hostOf('not a url')).toBeUndefined();
  });

  it('serves icons from Clarity', () => {
    expect(siteIconUrl('www.gsmarena.com')).toBe('https://api.clarity.surf/favicons/www.gsmarena.com');
  });

  it('accepts only public DNS names on the public route', () => {
    expect(isPublicHostname('www.gsmarena.com')).toBe(true);
    expect(isPublicHostname('localhost')).toBe(false);
    expect(isPublicHostname('127.0.0.1')).toBe(false);
    expect(isPublicHostname('metadata.internal')).toBe(false);
    expect(isPublicHostname('app.localhost')).toBe(false);
    expect(isPublicHostname('bad_host.com')).toBe(false);
  });
});

describe('fetchSiteIcon', () => {
  beforeEach(() => safeFetch.mockReset());

  it('takes the icon the crawled page declared first', async () => {
    safeFetch.mockResolvedValueOnce(answer(200, PNG, 'https://cdn.example.com/icon.png'));
    const icon = await fetchSiteIcon('example.com', 'https://cdn.example.com/icon.png');
    expect(icon).toMatchObject({ contentType: 'image/png', sourceUrl: 'https://cdn.example.com/icon.png' });
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to the home page declaration, then /favicon.ico', async () => {
    safeFetch
      .mockResolvedValueOnce(answer(404, '', 'https://example.com/missing.png'))
      .mockResolvedValueOnce(answer(200, '<html><head><link rel="shortcut icon" href="/brand.ico"></head></html>', 'https://example.com/'))
      .mockResolvedValueOnce(answer(200, '<!doctype html>not an icon', 'https://example.com/brand.ico'))
      .mockResolvedValueOnce(answer(200, ICO, 'https://example.com/favicon.ico'));

    const icon = await fetchSiteIcon('example.com', 'https://example.com/missing.png');

    expect(safeFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/missing.png',
      'https://example.com/',
      'https://example.com/brand.ico',
      'https://example.com/favicon.ico',
    ]);
    expect(icon).toMatchObject({ contentType: 'image/x-icon', sourceUrl: 'https://example.com/favicon.ico' });
  });

  it('gives up, rather than storing something too large or a fetch that failed', async () => {
    safeFetch
      .mockResolvedValueOnce(answer(200, Buffer.alloc(200 * 1024, 0x89), 'https://example.com/'))
      .mockRejectedValueOnce(new Error('SSRF rejected'));
    expect(await fetchSiteIcon('example.com', null)).toBeUndefined();
  });
});
