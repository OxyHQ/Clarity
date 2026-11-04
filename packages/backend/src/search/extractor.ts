import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

import { dateFromUrl, metadataFromStructuredData, plausibleDate } from './article-metadata.js';
import { hasJobPosting } from './jobs/extract.js';
import { storableUrl } from './query-primitives.js';

export interface FieldEvidence {
  source: string;
  selector?: string;
  extractedAt: string;
}

export interface ExtractedDocument {
  title?: string;
  description?: string;
  mainContent?: string;
  language?: string;
  canonicalUrl?: string;
  imageUrl?: string;
  faviconUrl?: string;
  publishedAt?: Date;
  modifiedAt?: Date;
  publisher?: string;
  /** The page's own oEmbed endpoint (`<link rel="alternate" type="application/json+oembed">`). */
  oembedUrl?: string;
  documentType:
    | 'page'
    | 'article'
    | 'news'
    | 'job'
    | 'product'
    | 'video'
    | 'event'
    | 'recipe'
    | 'profile'
    | 'documentation'
    | 'other';
  structuredData: unknown[];
  evidence: Record<string, FieldEvidence>;
  noindex: boolean;
  nofollow: boolean;
}

type Document = ReturnType<typeof parseHTML>['document'];

/** A field's value and where it was read. */
interface Found {
  value: string;
  evidence: Omit<FieldEvidence, 'extractedAt'>;
}

/**
 * Where a card's text and image come from, strongest first. What a page
 * declares for sharing — OpenGraph, then its Twitter card, then its JSON-LD —
 * outranks its bare `<title>`, meta description or what Readability infers from
 * the body; an oEmbed answer (search/oembed.ts) slots in between the two, so
 * it only replaces those weaker sources (see {@link isDeclared}).
 */
const TITLE_META = ['meta[property="og:title"]', 'meta[name="twitter:title"]'];
const DESCRIPTION_META = ['meta[property="og:description"]', 'meta[name="twitter:description"]'];
const IMAGE_META = [
  'meta[property="og:image"]',
  'meta[property="og:image:url"]',
  'meta[property="og:image:secure_url"]',
  'meta[name="twitter:image"]',
  'meta[name="twitter:image:src"]',
];
const DECLARED_SELECTORS = new Set([...TITLE_META, ...DESCRIPTION_META, ...IMAGE_META]);

/** Whether a field came from what the page declares for sharing (OpenGraph, Twitter card, JSON-LD). */
export function isDeclared(evidence: FieldEvidence | undefined): boolean {
  if (!evidence) return false;
  if (evidence.source === 'json_ld' || evidence.source === 'oembed') return true;
  return evidence.source === 'html' && DECLARED_SELECTORS.has(evidence.selector ?? '');
}

export function extractDocument(html: string, finalUrl: string): ExtractedDocument {
  const { document } = parseHTML(parseable(html));
  const extractedAt = new Date().toISOString();
  const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .flatMap((element) => {
      try {
        const parsed: unknown = JSON.parse(element.textContent || 'null');
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return [];
      }
    })
    .filter((value) => value !== null);
  // Everything the head states is read before Readability, which rewrites the
  // document it is given.
  const fromJsonLd = metadataFromStructuredData(jsonLd);
  const publishedAt =
    fromJsonLd.publishedAt ??
    plausibleDate(content(document, 'meta[property="article:published_time"]', 'content')) ??
    plausibleDate(content(document, 'meta[itemprop="datePublished"]', 'content')) ??
    plausibleDate(content(document, 'meta[name="date"]', 'content')) ??
    dateFromUrl(finalUrl);
  const modifiedAt =
    fromJsonLd.modifiedAt ??
    plausibleDate(content(document, 'meta[property="article:modified_time"]', 'content'));
  const publisher =
    fromJsonLd.publisher ??
    content(document, 'meta[property="og:site_name"]', 'content')?.slice(0, 200);
  const declaredTitle = firstMeta(document, TITLE_META) ?? jsonLdField(fromJsonLd.title);
  const declaredDescription =
    firstMeta(document, DESCRIPTION_META) ?? jsonLdField(fromJsonLd.description);
  const imageFound = firstMeta(document, IMAGE_META) ?? jsonLdField(fromJsonLd.image);
  const titleElement = clean(document.querySelector('title')?.textContent);
  const metaDescription = content(document, 'meta[name="description"]', 'content');
  const canonicalUrl = trustedCanonical(
    absolute(content(document, 'link[rel="canonical"]', 'href'), finalUrl),
    absolute(content(document, 'meta[property="og:url"]', 'content'), finalUrl),
    finalUrl,
  );
  const imageUrl = absolute(imageFound?.value, finalUrl);
  const faviconUrl = absolute(content(document, 'link[rel~="icon"]', 'href'), finalUrl);
  const oembedUrl = absolute(
    content(document, 'link[rel~="alternate"][type="application/json+oembed"]', 'href') ??
      content(document, 'link[rel~="alternate"][type="text/json+oembed"]', 'href'),
    finalUrl,
  );
  const language = document.documentElement.getAttribute('lang') || undefined;
  const robots =
    `${content(document, 'meta[name="robots"]', 'content') || ''},${content(document, 'meta[name="googlebot"]', 'content') || ''}`
      .toLowerCase()
      .split(',')
      .map((item) => item.trim());
  const readable = readableContent(document);
  const title: Found | undefined =
    declaredTitle ??
    (readable?.title
      ? { value: readable.title, evidence: { source: 'readability' } }
      : undefined) ??
    (titleElement
      ? { value: titleElement, evidence: { source: 'html', selector: 'title' } }
      : undefined);
  const description: Found | undefined =
    declaredDescription ??
    (metaDescription
      ? {
          value: metaDescription,
          evidence: { source: 'html', selector: 'meta[name="description"]' },
        }
      : undefined) ??
    (readable?.excerpt
      ? { value: readable.excerpt, evidence: { source: 'readability' } }
      : undefined);
  const stamp = (found: Found | undefined) =>
    found ? { ...found.evidence, extractedAt } : undefined;
  return {
    title: title?.value,
    description: description?.value,
    mainContent:
      readable?.textContent?.trim() ||
      document.body?.textContent?.replace(/\s+/g, ' ').trim() ||
      undefined,
    language,
    canonicalUrl,
    imageUrl,
    faviconUrl,
    publishedAt,
    modifiedAt,
    publisher,
    oembedUrl,
    documentType: classify(jsonLd),
    structuredData: jsonLd,
    evidence: Object.fromEntries(
      Object.entries({
        title: stamp(title),
        description: stamp(description),
        imageUrl: imageUrl ? stamp(imageFound) : undefined,
        canonicalUrl: canonicalUrl
          ? { source: 'html', selector: 'link[rel="canonical"]', extractedAt }
          : undefined,
      }).filter((entry): entry is [string, FieldEvidence] => entry[1] !== undefined),
    ),
    noindex: robots.includes('noindex'),
    nofollow: robots.includes('nofollow'),
  };
}

/**
 * The icon a page declares (`<link rel~="icon">`), absolute, read from its
 * `<head>` alone. The same answer as {@link extractDocument}'s `faviconUrl`
 * without parsing the body or running Readability over it, which is all the
 * favicon refresh needs from a home page.
 */
export function declaredIconUrl(html: string, finalUrl: string): string | undefined {
  const headEnd = html.search(/<\/head\s*>/i);
  const { document } = parseHTML(parseable(headEnd === -1 ? html : html.slice(0, headEnd)));
  return absolute(content(document, 'link[rel~="icon"]', 'href'), finalUrl);
}

/**
 * The markup as linkedom can parse it into a document. linkedom builds no
 * `<html>` root unless the markup starts with one (or a doctype): a page that
 * opens with whitespace, a BOM or a bare `<head>` came back with a null
 * `documentElement`, which crashed extraction and failed thousands of
 * fetchable pages a week. Whatever precedes the root that is not a comment or
 * an XML prolog is not part of the page, so the markup is cut to the root or,
 * without one, wrapped in one.
 */
function parseable(html: string): string {
  const root = html.search(/<!doctype\s|<html[\s>]/i);
  if (root >= 0 && /^(?:\s|﻿|<!--[\s\S]*?-->|<\?[\s\S]*?\?>)*$/.test(html.slice(0, root)))
    return html.slice(root);
  return `<!DOCTYPE html><html>${html}</html>`;
}

/**
 * The page's readable text, title and excerpt, or `undefined` when Readability
 * cannot read it. Readability throws on some real-world markup (an orphaned top
 * candidate, a node without a parent); that costs the page its body text, never
 * the title, description and image its head declares.
 */
function readableContent(document: Document) {
  try {
    return new Readability(document).parse();
  } catch {
    return null;
  }
}

/**
 * The declared canonical URL, when it names this page. A `<link rel=canonical>`
 * decides which document a fetch is stored as, so a wrong one merges unrelated
 * pages into one card: YouTube's degraded pages declare
 * `https://www.youtube.com/undefined` for every video, and a misconfigured site
 * names its home page for every article. It is accepted when it keeps the
 * fetched URL's path (dropping tracking parameters, `www.`/`m.` or a trailing
 * slash) or when the page's `og:url` states the same URL.
 */
function trustedCanonical(
  declared: string | undefined,
  ogUrl: string | undefined,
  finalUrl: string,
): string | undefined {
  if (!declared) return undefined;
  if (declared === ogUrl) return declared;
  const a = new URL(declared);
  const b = new URL(finalUrl);
  const host = (url: URL) => url.hostname.replace(/^(?:www|m)\./, '');
  const path = (url: URL) => url.pathname.replace(/\/+$/, '');
  return host(a) === host(b) && path(a) === path(b) ? declared : undefined;
}

function firstMeta(document: Document, selectors: readonly string[]): Found | undefined {
  for (const selector of selectors) {
    const value = content(document, selector, 'content');
    if (value) return { value, evidence: { source: 'html', selector } };
  }
  return undefined;
}

function jsonLdField(value: string | undefined): Found | undefined {
  return value ? { value, evidence: { source: 'json_ld' } } : undefined;
}

function clean(value: string | null | undefined): string | undefined {
  return value?.replace(/\s+/g, ' ').trim() || undefined;
}

function content(document: Document, selector: string, attribute: string): string | undefined {
  return document.querySelector(selector)?.getAttribute(attribute)?.trim() || undefined;
}

/** A page's own URL reference, absolute, or `undefined` when unusable or too long to store. */
function absolute(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, base).toString();
    return storableUrl(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

function classify(values: unknown[]): ExtractedDocument['documentType'] {
  const types = values
    .flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const type = (value as Record<string, unknown>)['@type'];
      return Array.isArray(type)
        ? type.filter((item): item is string => typeof item === 'string')
        : typeof type === 'string'
          ? [type]
          : [];
    })
    .map((type) => type.toLowerCase());
  if (hasJobPosting(values)) return 'job';
  if (types.some((type) => type.includes('newsarticle'))) return 'news';
  if (types.some((type) => type.includes('article'))) return 'article';
  if (types.some((type) => type.includes('product'))) return 'product';
  if (types.some((type) => type.includes('video'))) return 'video';
  if (types.some((type) => type.includes('event'))) return 'event';
  if (types.some((type) => type.includes('recipe'))) return 'recipe';
  if (types.some((type) => type.includes('person') || type.includes('profile'))) return 'profile';
  if (types.some((type) => type.includes('techarticle') || type.includes('api')))
    return 'documentation';
  return 'page';
}
