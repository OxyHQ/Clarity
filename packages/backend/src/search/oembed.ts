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

/** A registry URL scheme, split where its wildcards may match: host, then path and query. */
interface Scheme {
  host: string;
  rest: string;
}

interface Provider {
  endpoint: string;
  schemes: Scheme[];
}

function parseScheme(scheme: string): Scheme | undefined {
  const match = /^https?:\/\/([^/]*)(.*)$/i.exec(scheme);
  return match ? { host: match[1].toLowerCase(), rest: match[2] || '/' } : undefined;
}

/**
 * Whether `text` matches a `*` wildcard pattern. Greedy with one backtrack
 * point, so it is linear in practice and never exponential, unlike a regular
 * expression built from a scheme with several wildcards.
 */
function wildcard(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      resume = t;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else return false;
  }
  while (pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/**
 * Whether a URL is one a scheme covers. `*.` before a domain also covers the
 * bare domain, and a host wildcard never reaches into the path; http and https
 * are the same resource.
 */
function covers(scheme: Scheme, url: URL): boolean {
  const host = scheme.host.startsWith('*.')
    ? url.hostname === scheme.host.slice(2) || wildcard(scheme.host, url.hostname)
    : wildcard(scheme.host, url.hostname);
  return host && wildcard(scheme.rest, `${url.pathname}${url.search}`);
}

const providers: Provider[] = registry.map((provider) => ({
  endpoint: provider.endpoint,
  schemes: provider.schemes.flatMap((scheme) => parseScheme(scheme) ?? []),
}));

/** The endpoint request for `pageUrl`, if a registered provider covers it. */
export function registeredOembedUrl(pageUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const provider = providers.find((candidate) =>
    candidate.schemes.some((scheme) => covers(scheme, url)),
  );
  if (!provider) return undefined;
  const request = `${provider.endpoint}${provider.endpoint.includes('?') ? '&' : '?'}url=${encodeURIComponent(url.toString())}&format=json`;
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
