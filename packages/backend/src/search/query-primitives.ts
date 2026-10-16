/**
 * Request/response primitives shared by every Clarity search surface
 * (documents, news and the Jobs vertical). One definition each, so the public
 * cursor format and URL canonicalization cannot drift between verticals.
 */

import { z } from 'zod';

/** Public HTTP(S) URL in the exact shape Clarity stores as a canonical URL. */
export function canonicalizePublicUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only public HTTP(S) URLs are supported');
  }
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  )
    url.port = '';
  return url.toString();
}

/**
 * A request field holding a public HTTP(S) URL, parsed to its canonical form.
 * Validating here makes a non-public URL (another scheme, embedded credentials,
 * or no URL at all) the caller's 400 instead of an unhandled throw later on.
 */
export const publicUrlSchema = z.string().transform((value, ctx) => {
  try {
    return canonicalizePublicUrl(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Only public HTTP(S) URLs are supported' });
    return z.NEVER;
  }
});

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function excerpt(value: string | null | undefined, length = 300): string | undefined {
  if (!value) return undefined;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed
    ? `${collapsed.slice(0, length)}${collapsed.length > length ? '…' : ''}`
    : undefined;
}

export function encodeSearchCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url');
}

/** Returns `undefined` for a cursor that was not issued by Clarity. */
export function decodeSearchCursor(value?: string): number | undefined {
  if (!value) return 0;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('offset' in parsed)) return undefined;
    const offset = parsed.offset;
    return typeof offset === 'number' &&
      Number.isSafeInteger(offset) &&
      offset >= 0 &&
      offset <= 10_000
      ? offset
      : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
