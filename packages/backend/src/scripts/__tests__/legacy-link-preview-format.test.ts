import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { parseLegacyLinkPreviewExport } from '../legacy-link-preview-format.js';

const record = JSON.stringify({
  type: 'link_preview', id: 'abc', requestedUrl: 'https://example.com/a', canonicalUrl: 'https://example.com/a',
  title: 'A', description: null, siteName: 'Example', faviconUrl: null, imageUrl: null,
  resolverVersion: 2, resolvedAt: '2026-01-01T00:00:00.000Z', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

function exportText(line = record, count = 1): string {
  const checksum = createHash('sha256').update(`${line}\n`).digest('hex');
  return `${JSON.stringify({ type: 'manifest', format: 'oxy-link-previews', version: 1, recordCount: count, recordsSha256: checksum })}\n${line}\n`;
}

describe('parseLegacyLinkPreviewExport', () => {
  it('validates and parses a versioned export', () => {
    expect(parseLegacyLinkPreviewExport(exportText()).records[0]?.canonicalUrl).toBe('https://example.com/a');
  });

  it('rejects a count mismatch', () => {
    expect(() => parseLegacyLinkPreviewExport(exportText(record, 2))).toThrow('Record count mismatch');
  });

  it('rejects tampered records', () => {
    expect(() => parseLegacyLinkPreviewExport(exportText().replace('"title":"A"', '"title":"B"'))).toThrow('checksum');
  });
});
