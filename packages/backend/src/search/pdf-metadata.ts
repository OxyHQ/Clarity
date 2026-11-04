/**
 * A linked PDF's card: the title its metadata states, else its file name.
 *
 * Read from the bytes Clarity fetched (at most the crawl's body limit), with
 * no PDF renderer: the XMP packet's `dc:title`, then the document information
 * dictionary's `/Title`, as a literal or hex string. A title kept inside a
 * compressed object stream is not readable this way; the file name is then
 * the honest label (`gov.uscourts.mnd.234415.1.0_2.pdf`), as a browser's tab
 * shows it.
 */

/** The title a PDF's metadata states, if it can be read without decompressing. */
export function pdfTitle(body: Buffer): string | undefined {
  const text = body.toString('latin1');
  const xmp = /<dc:title>[\s\S]{0,400}?<rdf:li[^>]*>([^<]{1,500})<\/rdf:li>/.exec(text)?.[1];
  const fromXmp = xmp ? clean(Buffer.from(xmp, 'latin1').toString('utf8')) : undefined;
  if (fromXmp) return fromXmp;
  const literal = /\/Title\s*\(((?:\\[\s\S]|[^\\)]){1,1000})\)/.exec(text)?.[1];
  if (literal) return clean(pdfString(Buffer.from(unescapeLiteral(literal), 'latin1')));
  const hex = /\/Title\s*<([0-9A-Fa-f\s]{2,2000})>/.exec(text)?.[1];
  if (hex) return clean(pdfString(Buffer.from(hex.replace(/\s/g, ''), 'hex')));
  return undefined;
}

/** The URL's file name, decoded: what a PDF is called when its metadata names nothing. */
export function fileName(url: string): string | undefined {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).at(-1);
    return segment ? clean(decodeURIComponent(segment)) : undefined;
  } catch {
    return undefined;
  }
}

/** A PDF text string: UTF-16BE behind its byte-order mark, else PDFDocEncoding (≈ latin1). */
function pdfString(bytes: Buffer): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  return bytes.toString('latin1');
}

/** A literal string's escapes (`\n`, `\(`, `\\`, octal `\ddd`) resolved. */
function unescapeLiteral(value: string): string {
  return value.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (_match, sequence: string) => {
    if (/^[0-7]+$/.test(sequence)) return String.fromCharCode(Number.parseInt(sequence, 8));
    const named: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
    // A backslash before a line break continues the string on the next line.
    return named[sequence] ?? (/^\r?\n$/.test(sequence) ? '' : sequence);
  });
}

function clean(value: string): string | undefined {
  const text = value
    .replaceAll('\uFEFF', '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: PDF strings carry control bytes.
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 500) : undefined;
}
