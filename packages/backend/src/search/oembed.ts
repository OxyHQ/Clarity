/**
 * oEmbed (https://oembed.com): a publisher's own answer to "what is at this
 * URL?", made for link previews.
 *
 * Two ways to an endpoint: the page's own `<link rel="alternate"
 * type="application/json+oembed">` (read by the extractor) when its HTML was
 * fetched, and the official provider registry
 * (`oembed-providers.generated.json`, refreshed with `bun run oembed:refresh`)
 * for a page Clarity could not fetch or that declared nothing. Endpoint
 * requests are ClarityBot's like any other: under the endpoint origin's
 * robots.txt, through `safeFetch`, bounded in size and time.
 *
 * The answer is plain data. Its `html` (an embed snippet) is never read, stored
 * or rendered; only the text fields and the thumbnail URL are kept, and the
 * thumbnail is served through Clarity's image cache like any page image.
 */
import { readResponseJson, safeFetch } from '@oxy.so/core/server';

import { asRecord } from '../lib/json-record.js';
import { createLogger } from '../lib/logger.js';
import { dateFromUrl, plausibleDate } from './article-metadata.js';
import { type ExtractedDocument, type FieldEvidence, isDeclared } from './extractor.js';
import { FEED_USER_AGENT, robotsAllowUrl } from './jobs/feeds/robots.js';
import registry from './oembed-providers.generated.json';
import { storableUrl } from './query-primitives.js';

const log = createLogger('oembed');
const MAX_BYTES = 256 * 1024;

export interface OembedMetadata {
  title?: string;
  description?: string;
  authorName?: string;
  providerName?: string;
  thumbnailUrl?: string;
  publishedAt?: Date;
  type?: string;
}

interface Provider {
  endpoint: string;
  patterns: RegExp[];
}

/**
 * A registry URL scheme as a pattern. `*` in the host matches within the host
 * only, and `*.` before a domain also matches the bare domain; `*` in the path
 * matches anything. http and https are the same resource.
 */
function schemePattern(scheme: string): RegExp {
  const match = /^https?:\/\/([^/]*)(.*)$/i.exec(scheme);
  if (!match) return /$^/;
  const literal = (value: string) => value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const host = literal(match[1].toLowerCase())
    .replace(/^\*\\\./, '(?:[^/]+\\.)?')
    .replace(/\*/g, '[^/]*');
  const path = literal(match[2]).replace(/\*/g, '.*');
  return new RegExp(`^https?://${host}${path || '/?'}$`);
}

const providers: Provider[] = registry.map((provider) => ({
  endpoint: provider.endpoint,
  patterns: provider.schemes.map(schemePattern),
}));

/** The endpoint request for `pageUrl`, if a registered provider covers it. */
export function registeredOembedUrl(pageUrl: string): string | undefined {
  let url: string;
  try {
    url = new URL(pageUrl).toString();
  } catch {
    return undefined;
  }
  const provider = providers.find((candidate) =>
    candidate.patterns.some((pattern) => pattern.test(url)),
  );
  if (!provider) return undefined;
  const request = `${provider.endpoint}${provider.endpoint.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}&format=json`;
  return storableUrl(request) ? request : undefined;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : undefined;
}

/**
 * The fields of an oEmbed answer a card can use. `description` and `summary`
 * are not in the specification but publishers send them (The New York Times
 * sends `summary` and `publication_date`). `html` is deliberately not read.
 */
export function parseOembed(value: unknown): OembedMetadata | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const thumbnail = text(record.thumbnail_url, 2_000);
  const metadata: OembedMetadata = {
    title: text(record.title, 500),
    description: text(record.description, 1_000) ?? text(record.summary, 1_000),
    authorName: text(record.author_name, 200),
    providerName: text(record.provider_name, 200),
    thumbnailUrl: thumbnail && /^https?:\/\//i.test(thumbnail) ? thumbnail : undefined,
    publishedAt: plausibleDate(record.publication_date),
    type: text(record.type, 20),
  };
  return metadata.title || metadata.thumbnailUrl ? metadata : undefined;
}

/** The endpoint's answer, or `undefined` when robots.txt, the network or the answer says no. */
export async function fetchOembed(requestUrl: string): Promise<OembedMetadata | undefined> {
  try {
    if (!(await robotsAllowUrl(requestUrl))) return undefined;
    const result = await safeFetch(requestUrl, {
      headers: { 'User-Agent': FEED_USER_AGENT, accept: 'application/json' },
      maxRedirects: 3,
      headersTimeoutMs: 10_000,
      signal: AbortSignal.timeout(15_000),
    });
    if (result.status !== 200) {
      result.response.destroy();
      return undefined;
    }
    const body = await readResponseJson(result.response, {
      maxBytes: MAX_BYTES,
      timeoutMs: 10_000,
    });
    return body.kind === 'ok' ? parseOembed(body.value) : undefined;
  } catch (error) {
    log.debug({ err: error }, 'oEmbed request failed');
    return undefined;
  }
}

/** Fields a page left undeclared, for which an oEmbed answer is worth asking. */
export function wantsOembed(extracted: ExtractedDocument): boolean {
  return (
    !isDeclared(extracted.evidence.title) ||
    !isDeclared(extracted.evidence.description) ||
    !extracted.imageUrl
  );
}

/**
 * `extracted` completed from an oEmbed answer. oEmbed outranks only what the
 * page did not declare for sharing (its bare `<title>`, meta description or
 * Readability's guesses) and fills what is missing; a declared field stays.
 */
export function applyOembed(
  extracted: ExtractedDocument,
  oembed: OembedMetadata,
  requestUrl: string,
): ExtractedDocument {
  const evidence: FieldEvidence = {
    source: 'oembed',
    selector: new URL(requestUrl).origin,
    extractedAt: new Date().toISOString(),
  };
  const next = { ...extracted, evidence: { ...extracted.evidence } };
  if (oembed.title && !isDeclared(extracted.evidence.title)) {
    next.title = oembed.title;
    next.evidence.title = evidence;
  }
  if (oembed.description && !isDeclared(extracted.evidence.description)) {
    next.description = oembed.description;
    next.evidence.description = evidence;
  }
  if (oembed.thumbnailUrl && !extracted.imageUrl && storableUrl(oembed.thumbnailUrl)) {
    next.imageUrl = oembed.thumbnailUrl;
    next.evidence.imageUrl = evidence;
  }
  next.publisher ??= oembed.providerName;
  next.publishedAt ??= oembed.publishedAt;
  if (oembed.type === 'video' && next.documentType === 'page') next.documentType = 'video';
  return next;
}

/** A document for a page known only through its oEmbed answer. */
export function documentFromOembed(
  oembed: OembedMetadata,
  requestUrl: string,
  pageUrl: string,
): ExtractedDocument {
  const document = applyOembed(
    { documentType: 'page', structuredData: [], evidence: {}, noindex: false, nofollow: false },
    oembed,
    requestUrl,
  );
  document.publishedAt ??= dateFromUrl(pageUrl);
  return document;
}
