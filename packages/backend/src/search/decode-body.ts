/**
 * A fetched body as text, in the charset it is written in.
 *
 * The charset comes from, in order: the Content-Type header, a byte-order mark,
 * then a `<meta charset>` (or `http-equiv` Content-Type) in the first 1,024
 * bytes — the WHATWG prescan window. Many sites still serve windows-1252,
 * Shift_JIS, EUC-KR or GBK, often declaring it only in the page; read as UTF-8
 * their titles came out as replacement characters. A label the runtime does
 * not know falls back to UTF-8.
 */
const PRESCAN_BYTES = 1_024;

export function decodeBody(body: Buffer, contentType: string | string[] | undefined): string {
  const header = Array.isArray(contentType) ? contentType[0] : contentType;
  const charset = charsetOf(header) ?? bomCharset(body) ?? declaredCharset(body);
  if (charset && charset !== 'utf-8' && charset !== 'utf8') {
    try {
      // The label is whatever the server wrote; TextDecoder validates it and
      // throws on one it does not know (caught below). It also drops a BOM.
      return new TextDecoder(charset as ConstructorParameters<typeof TextDecoder>[0]).decode(body);
    } catch {
      // An unknown label falls through to UTF-8.
    }
  }
  return new TextDecoder('utf-8').decode(body);
}

function charsetOf(value: string | undefined): string | undefined {
  return /charset\s*=\s*["']?([\w.:-]+)/i.exec(value ?? '')?.[1]?.toLowerCase();
}

function bomCharset(body: Buffer): string | undefined {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return 'utf-8';
  if (body[0] === 0xff && body[1] === 0xfe) return 'utf-16le';
  if (body[0] === 0xfe && body[1] === 0xff) return 'utf-16be';
  return undefined;
}

/** The charset a page declares in its first bytes (`<meta charset>` or `http-equiv`). */
function declaredCharset(body: Buffer): string | undefined {
  const head = body.subarray(0, PRESCAN_BYTES).toString('latin1');
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const direct = /\bcharset\s*=\s*["']?([\w.:-]+)/i.exec(tag)?.[1];
    if (direct) return direct.toLowerCase();
  }
  return undefined;
}
