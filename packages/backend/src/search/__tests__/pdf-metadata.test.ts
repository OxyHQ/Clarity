import { describe, expect, it } from 'vitest';

import { fileName, pdfTitle } from '../pdf-metadata.js';

describe('PDF metadata', () => {
  it('reads the stated title (XMP, literal or UTF-16 hex), else names the file', () => {
    const xmp = Buffer.from(
      '%PDF-1.7\n<x:xmpmeta><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Complaint (Doc. 1)</rdf:li></rdf:Alt></dc:title>',
    );
    expect(pdfTitle(xmp)).toBe('Complaint (Doc. 1)');
    expect(pdfTitle(Buffer.from('1 0 obj << /Title (Order \\(granted\\)) /Author (x) >>'))).toBe(
      'Order (granted)',
    );
    expect(pdfTitle(Buffer.from('<< /Title <FEFF00C9007400E9> >>'))).toBe('Été');
    expect(pdfTitle(Buffer.from('%PDF-1.7 stream compressed'))).toBeUndefined();
    expect(fileName('https://storage.example/recap/gov.uscourts.mnd.1.0_2.pdf?x=1')).toBe(
      'gov.uscourts.mnd.1.0_2.pdf',
    );
  });
});
